import { generateEvidenceBasedSummary, AuxStats } from './summaryEngine';
import { ApiKeyConfig, AiProvider, Dataset, QueryInsight, ChartSuggestion, ReasoningStep, QueryExecutionStatus } from '../types';
import { executeClientSql, executeValidatedSql, ExecutionOutput } from './sqlEngine';
import { profileDatasetSchema, formatSemanticSchemaPrompt, SemanticSchema } from './schemaProfiler';
import { QueryPlan, parseQueryPlan, formatQueryPlanSummary } from './queryPlan';
import { getBlueprintPromptSection, constructSqlFromPlan } from './sqlBlueprints';
import { validateSqlIntent, validateExecutionResult, ValidationResult, checkMetricAvailability } from './validators';
import { selectDeterministicVisualization } from './visualizationSelector';
import {
  DEFAULT_MODELS,
  DEFAULT_PROVIDER,
  getModel,
  validateModelCapabilities,
} from './modelRegistry';
import { LocalQueryStorage } from './localQueryStorage';
import { TemplateMatcher } from './templateMatcher';
import { telemetryAuditor } from './telemetryAuditor';


export interface AiQueryResult {
  isOutOfScope?: boolean;
  outOfScopeReason?: string;
  suggestedQuestions?: string[];
  sql: string;
  reasoningSteps: ReasoningStep[];
  insight: QueryInsight;
  chartSuggestion?: ChartSuggestion;
  usedProvider: string;
  queryPlan?: QueryPlan;
  validationRounds?: number;
  status?: QueryExecutionStatus;
  passedChecks?: string[];
  clarificationMessage?: string;
  execution?: ExecutionOutput;
}

const MAX_AGENT_ROUNDS = 5;

/**
 * DuckDB quotes the offending cell value inside its runtime errors ("Could not convert string
 * 'Alpha' to INT64"), and on a self-correction round that error text is sent back to the
 * provider. The value is the least useful part of the message for repairing the SQL, so every
 * single-quoted literal is withheld on the way out. The schema notice promises no cell pairings
 * leave the browser, and this is what keeps that promise true for the correction path.
 */
export function redactCellValuesForEgress(text: string): string {
  if (!text) return text;
  return text.replace(/'(?:[^'\\\n]|\\.){1,400}'/g, "'<cell value withheld>'");
}

/**
 * Builds the comprehensive prompt for LLM SQL and Plan Generation.
 */
function buildPromptSystem(schema: SemanticSchema): string {
  const schemaText = formatSemanticSchemaPrompt(schema, {
    strictZeroContentEgress: true,
    allowCategoricalEnums: false,
  });
  const blueprintsText = getBlueprintPromptSection();

  return `You are QueryMind, an elite deterministic AI data analyst and SQL architect. Generated SQL executes locally in the user's browser on DuckDB-WASM.
Your goal is to parse the user's natural language question, produce a formal intermediate Query Plan, and generate accurate DuckDB-WASM SQL.

${schemaText}

${blueprintsText}

CRITICAL RULES:
1. First, check if the question can be answered using the dataset schema. If question is about external trivia, celebrities, politics, memes, weather, or sports completely absent from columns, return JSON:
{
  "isOutOfScope": true,
  "outOfScopeReason": "Clear explanation of why this question is outside dataset scope.",
  "suggestedQuestions": ["Question 1", "Question 2", "Question 3"]
}

2. For IN-SCOPE questions:
   - Produce a strict JSON object with both "queryPlan" and "sql".
   - ONLY produce read-only SELECT or WITH ... SELECT queries.
   - For queries asking for "most / top / best / highest in EACH / EVERY / PER group/region":
     YOU MUST USE A CTE with ROW_NUMBER() OVER (PARTITION BY <group_col> ORDER BY <metric> DESC) and filter WHERE rank = 1.
   - RESPECT REQUESTED LIMITS: If the question requests "top 5" or "5 customers/records", YOU MUST USE "LIMIT 5". Never output LIMIT 10 when top 5 is requested.
   - EXPLICIT FILTERING: If the question mentions specific categorical values present in the schema (e.g. "Enterprise", "Technology", "Active", "Churned"), YOU MUST include them in the WHERE clause (e.g. WHERE plan_tier = 'Enterprise'). Never omit a requested filter.
   - LOST REVENUE / MRR: If the question asks for "lost MRR" or "lost revenue", filter on churned/at-risk status (e.g. churn_status IN ('Churned', 'At-Risk') or churn_status = 'Churned').
   - HIGH TICKETS / QUALIFIERS: If the question mentions "with high support tickets", specify an explicit threshold (e.g. support_tickets >= 5) and document it in the reasoning.
   - ACCURATE NARRATIVE: The insight summary and highlights MUST agree strictly with the SQL query and returned row count. State the exact number of records returned. Never claim to show 10 records when 5 were requested.
   - Ensure the column names match the schema exactly (e.g. "quantity" for units sold, "sales" for revenue, "profit" for profit).
   - INSIGHTS MUST BE CAUTIOUS: Do not infer causal explanations from correlation alone. Do not suggest business actions that cannot reasonably be supported by the available data. If the data is limited, provide a cautious, accurately scoped observation. Do not use financial terms like "net operating margin" unless the data explicitly defines it.

RESPONSE JSON FORMAT:
{
  "isOutOfScope": false,
  "queryPlan": {
    "intent": "top_n_per_group" | "aggregate_by_dimension" | "ranking" | "comparison" | "filter_lookup" | "distribution" | "percentage_of_total" | "time_trend" | "overview",
    "partition_by": ["region"],
    "item_entity": "product",
    "dimensions": ["region", "product"],
    "metric": "quantity",
    "aggregation": "SUM",
    "ranking_direction": "DESC",
    "limit": 1,
    "scope": "each_group",
    "filters": [],
    "explanation": "Identify highest sold product for each distinct region using window ranking."
  },
  "sql": "WITH ... SELECT ...",
  "reasoningSteps": [
    { "title": "Intent Understanding", "detail": "Identified goal..." },
    { "title": "Semantic Schema Grounding", "detail": "Mapped dimensions and metrics..." },
    { "title": "SQL Architecture", "detail": "Formulated DuckDB query..." }
  ],
  "insight": {
    "executive_summary": "One tight sentence with actual numbers from the result. Example: '4 Enterprise accounts totalling $25,900 at-risk MRR were identified with support tickets ≥ 5.'",
    "kpi_callouts": [
      {
        "label": "Short metric label (3-4 words max)",
        "value": "Formatted value string with units e.g. '$25,900' or '4 accounts' or '67%'",
        "delta": "Optional: change vs baseline e.g. '+12%' or '-$3.2K'",
        "direction": "up | down | neutral",
        "context": "Optional: 1 short phrase giving context e.g. 'of total Enterprise MRR'"
      }
    ],
    "findings": [
      "Specific factual sentence with actual data values from the result. Must reference column values. Example: 'Aura Commerce leads at-risk revenue at $6,800 with 13 support tickets and NPS 5.'",
      "Another factual data-driven finding. Do NOT use vague language like 'some accounts' or 'certain products'."
    ],
    "risks": [
      "If the dataset is small or the metric is proxied, note it clearly. Example: 'MRR used as churn revenue proxy since a dedicated lost_mrr column is absent.'"
    ],
    "recommended_action": "One actionable sentence beginning with a verb. Must be directly supported by the data values. Example: 'Initiate executive outreach to Aura Commerce and AeroFleet Mobility within 48 hours to prevent combined $13,500 churn.'"
  },
  "chartSuggestion": {
    "type": "bar | horizontal_bar | line | donut",
    "xAxisKey": "column_for_x_axis",
    "yAxisKey": "column_for_y_axis",
    "title": "Clear, specific chart title referencing the metric (e.g. 'At-Risk MRR by Enterprise Customer')",
    "valuePrefix": "$ (if currency metric, else omit)",
    "valueSuffix": "% (if percentage metric, else omit)",
    "highlightIndex": 0
  }
}

Respond ONLY with valid JSON without any markdown code fences.`;
}

/**
 * Extracts Gemini's server-advised retry delay (error.details[].retryDelay, e.g. "17.5s").
 */
function extractRetryDelayMs(bodyText: string): number | null {
  try {
    const parsed = JSON.parse(bodyText);
    const details = parsed?.error?.details;
    if (Array.isArray(details)) {
      for (const d of details) {
        if (typeof d?.retryDelay === 'string') {
          const m = d.retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
          if (m) return Math.min(Math.round(parseFloat(m[1]) * 1000), 60000);
        }
      }
    }
  } catch {
    // Body was not JSON — no advisory delay available.
  }
  return null;
}

/**
 * Exponential backoff with jitter. Honors the provider-advised retry delay when it is longer.
 */
function backoffDelayMs(attempt: number, retryDelayMs: number | null = null): number {
  const exponential = 1500 * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * 400);
  return Math.max(exponential, retryDelayMs ?? 0) + jitter;
}

// Client-side pacing: minimum gap between consecutive provider dispatches so the
// self-correction loop can never burst past the free-tier requests-per-minute quota.
const MIN_DISPATCH_INTERVAL_MS = 1500;
let lastDispatchAt = 0;

interface ProviderRequestContext {
  systemPrompt: string;
  userPrompt: string;
  schemaColumns: string[];
  datasetRows?: Record<string, any>[];
  signal: AbortSignal;
}

// A provider socket that opens but never answers would otherwise hang the query until the
// browser gives up, so every dispatch carries its own deadline separate from user cancel.
// Free-tier Gemini planning calls were measured at 13-45s (queueing, not thinking depth),
// so the cap must sit well above that range or healthy requests get aborted.
export const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 90000;
let providerRequestTimeoutMs = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;

export function setProviderRequestTimeoutForTesting(ms: number | null): void {
  providerRequestTimeoutMs = ms === null ? DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS : ms;
}

function createDeadlineSignal(cancelSignal: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Provider request timed out.', 'TimeoutError'));
  }, timeoutMs);
  const onCancel = () => controller.abort(cancelSignal.reason);
  if (cancelSignal.aborted) {
    onCancel();
  } else {
    cancelSignal.addEventListener('abort', onCancel, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      cancelSignal.removeEventListener('abort', onCancel);
    },
  };
}

function waitForProvider(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchAuditedProvider(
  provider: AiProvider,
  model: string,
  endpointUrl: string,
  options: RequestInit,
  context: ProviderRequestContext
): Promise<Response> {
  context.signal.throwIfAborted();
  const eventId = telemetryAuditor.recordOutboundDispatch({
    provider, model, endpointUrl,
    userPrompt: context.userPrompt,
    systemPrompt: context.systemPrompt,
    schemaColumns: context.schemaColumns,
    requestBody: options.body,
    datasetRows: context.datasetRows,
  });
  const started = performance.now();
  const deadline = createDeadlineSignal(context.signal, providerRequestTimeoutMs);
  try {
    const response = await fetch(endpointUrl, { ...options, signal: deadline.signal, redirect: 'error' });
    telemetryAuditor.recordResponse(eventId, {
      status: response.ok ? 'success' : 'error',
      httpStatus: response.status,
      latencyMs: Math.round(performance.now() - started),
    });
    return response;
  } catch (error) {
    const timedOut = deadline.timedOut() && !context.signal.aborted;
    telemetryAuditor.recordResponse(eventId, {
      status: 'error',
      latencyMs: Math.round(performance.now() - started),
      error: timedOut ? 'Provider request timed out.' : context.signal.aborted ? 'Query cancelled.' : 'Provider transport failed.',
    });
    if (timedOut) {
      throw new Error(
        `The AI provider did not respond within ${Math.round(providerRequestTimeoutMs / 1000)}s. ` +
          'No SQL was generated and nothing was executed; run the query again to retry.'
      );
    }
    throw error;
  } finally {
    deadline.dispose();
  }
}

function isRetryableProviderError(error: Error): boolean {
  return /failed to fetch|network|malformed JSON|empty response/i.test(error.message) || error instanceof SyntaxError;
}

// A non-JSON body (an HTML gateway page, a truncated stream) has to be reported as a
// transport failure rather than as the engine's raw parser message. The body text itself is
// never echoed back: gateway pages can carry request metadata, and nothing on the wire
// belongs in the UI.
async function readProviderJsonBody(response: Response, providerLabel: string, model: string): Promise<any> {
  const raw = await response.text();
  try {
    return JSON.parse(raw);
  } catch {
    throw new SyntaxError(
      `${providerLabel} model "${model}" returned a response that is not valid JSON ` +
        `(${raw.trim().length === 0 ? 'empty body' : `${raw.length} characters of ${response.headers.get('content-type') || 'unknown type'}`}). ` +
        'No SQL was generated and nothing was executed.'
    );
  }
}

async function throttleDispatch(signal: AbortSignal, onNotice?: (notice: string) => void): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastDispatchAt;
  if (elapsed < MIN_DISPATCH_INTERVAL_MS) {
    const waitMs = MIN_DISPATCH_INTERVAL_MS - elapsed;
    onNotice?.(`Rate-limit protection: spacing AI requests by ${(waitMs / 1000).toFixed(1)}s...`);
    await waitForProvider(waitMs, signal);
  }
  lastDispatchAt = Date.now();
}

function parseModelJson(text: string, providerName: string): any {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${providerName} returned a malformed JSON response. The response could not be parsed.`);
  }
}

/**
 * Calls Google Gemini REST API with retry & exponential backoff on transient errors (503, 429).
 * Strictly operates on requested model without silent cross-model failover.
 */
async function callGemini(
  apiKey: string,
  requestedModel: string,
  prompt: string,
  onRetryNotice: ((notice: string) => void) | undefined,
  context: ProviderRequestContext
): Promise<{ data: any; effectiveModel: string }> {
  const targetModel = requestedModel && getModel('gemini', requestedModel)
    ? requestedModel
    : DEFAULT_MODELS.gemini;

  const MAX_ATTEMPTS = 3;
  let lastError: any = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent`;
      const response = await fetchAuditedProvider('gemini', targetModel, url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
          },
        }),
      }, context);

      // 1. Model Not Found (404)
      if (response.status === 404) {
        throw new Error(
          `Google Gemini model "${targetModel}" was not found (HTTP 404). Suggestion: Open Settings to choose an active model such as Gemini 3.8 Flash.`
        );
      }

      // 2. Model Server Overloaded / Busy (503) or Rate Limit (429) or Gateway Error (500/502/504)
      if (
        response.status === 503 ||
        response.status === 429 ||
        response.status === 500 ||
        response.status === 502 ||
        response.status === 504
      ) {
        const errorBody = await response.text();
        lastError = new Error(
          `Google Gemini model "${targetModel}" is temporarily busy or rate limited (HTTP ${response.status})`
        );

        if (attempt < MAX_ATTEMPTS) {
          const retryDelayMs = response.status === 429 ? extractRetryDelayMs(errorBody) : null;
          const backoffMs = backoffDelayMs(attempt, retryDelayMs);
          const delayNote = retryDelayMs ? ` (server asked to wait ${Math.round(retryDelayMs / 1000)}s)` : '';
          onRetryNotice?.(
            `Gemini server is busy on ${targetModel} (HTTP ${response.status}). Retrying in ${(backoffMs / 1000).toFixed(1)}s${delayNote} (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`
          );
          await waitForProvider(backoffMs, context.signal);
          continue;
        }

        const quotaNote =
          response.status === 429
            ? `Google Gemini free tier enforces a requests-per-minute quota that was exceeded. Suggestion: Wait 30-60 seconds for the per-minute window to reset, then retry. If this persists, open Settings (gear icon) to switch to another Gemini model or Groq Cloud.`
            : `Suggestion: Wait a few seconds to retry, or open Settings (gear icon) to switch to another Gemini model or Groq Cloud.`;
        throw new Error(
          `Google Gemini model "${targetModel}" server is busy or rate limited (HTTP ${response.status}) after ${MAX_ATTEMPTS} attempts. ${quotaNote}`
        );
      }

      if (!response.ok) {
        const errorBody = await response.text();
        if (response.status === 401 || response.status === 403 || (response.status === 400 && /API_KEY_INVALID|API key not valid/i.test(errorBody))) {
          throw new Error(
            `Google Gemini rejected the API key (HTTP ${response.status}). No SQL was generated; re-enter or replace the key in Settings.`
          );
        }
        throw new Error(`Google Gemini API error (${response.status})`);
      }

      const data = await readProviderJsonBody(response, 'Google Gemini', targetModel);
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Empty response received from Gemini.');
      return { data: parseModelJson(text, 'Gemini'), effectiveModel: targetModel };
    } catch (err: any) {
      context.signal.throwIfAborted();
      lastError = err;
      const msg = (err.message || '').toLowerCase();
      if (
        msg.includes('suggestion:') ||
        msg.includes('404') ||
        msg.includes('invalid') ||
        msg.includes('unauthorized')
      ) {
        throw err;
      }
      if (attempt < MAX_ATTEMPTS && isRetryableProviderError(err)) {
        const backoffMs = backoffDelayMs(attempt);
        onRetryNotice?.(`Connection issue with Gemini, retrying in ${(backoffMs / 1000).toFixed(1)}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`);
        await waitForProvider(backoffMs, context.signal);
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error(`Failed to call Google Gemini model "${targetModel}".`);
}

/**
 * Calls Groq Cloud API with retry on transient congestion.
 * Uses requested model without silent cross-model failover.
 */
async function callGroq(
  apiKey: string,
  requestedModel: string,
  systemPrompt: string,
  userPrompt: string,
  onRetryNotice: ((notice: string) => void) | undefined,
  context: ProviderRequestContext
): Promise<{ data: any; effectiveModel: string }> {
  const targetModel = requestedModel && getModel('groq', requestedModel)
    ? requestedModel
    : DEFAULT_MODELS.groq;

  const MAX_ATTEMPTS = 3;
  let lastError: any = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchAuditedProvider('groq', targetModel, 'https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: targetModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        }),
      }, context);

      if (response.status === 404) {
        throw new Error(
          `Groq model "${targetModel}" is not found or has been decommissioned (HTTP 404). Suggestion: Open Settings to choose an active model like GPT-OSS 120B.`
        );
      }

      if (response.status === 503 || response.status === 429 || response.status === 500) {
        const errorBody = await response.text();
        lastError = new Error(`Groq model "${targetModel}" is busy (HTTP ${response.status})`);
        if (attempt < MAX_ATTEMPTS) {
          const backoffMs = backoffDelayMs(attempt);
          onRetryNotice?.(
            `Groq Cloud is rate limited or busy on ${targetModel}. Retrying in ${(backoffMs / 1000).toFixed(1)}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`
          );
          await waitForProvider(backoffMs, context.signal);
          continue;
        }
        throw new Error(
          `Groq Cloud model "${targetModel}" error (${response.status}) after ${MAX_ATTEMPTS} attempts. Suggestion: Wait a moment or switch models in Settings.`
        );
      }

      if (!response.ok) {
        await response.text();
        if (response.status === 401 || response.status === 403) {
          throw new Error(
            `Groq rejected the API key (HTTP ${response.status}). No SQL was generated; re-enter or replace the key in Settings.`
          );
        }
        throw new Error(`Groq API error (${response.status})`);
      }

      const data = await readProviderJsonBody(response, 'Groq', targetModel);
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty response received from Groq.');
      return { data: parseModelJson(content, 'Groq'), effectiveModel: targetModel };
    } catch (err: any) {
      context.signal.throwIfAborted();
      lastError = err;
      const msg = (err.message || '').toLowerCase();
      if (msg.includes('suggestion:') || msg.includes('404')) {
        throw err;
      }
      if (attempt < MAX_ATTEMPTS && isRetryableProviderError(err)) {
        await waitForProvider(backoffDelayMs(attempt), context.signal);
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error(`Failed to call Groq model "${targetModel}".`);
}

/**
 * Calls OpenAI API with retry on transient congestion.
 * Uses requested model from current catalog.
 */
async function callOpenAi(
  apiKey: string,
  requestedModel: string,
  systemPrompt: string,
  userPrompt: string,
  onRetryNotice: ((notice: string) => void) | undefined,
  context: ProviderRequestContext
): Promise<{ data: any; effectiveModel: string }> {
  const targetModel = requestedModel && getModel('openai', requestedModel)
    ? requestedModel
    : DEFAULT_MODELS.openai;

  const MAX_ATTEMPTS = 3;
  let lastError: any = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchAuditedProvider('openai', targetModel, 'https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: targetModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        }),
      }, context);

      if (response.status === 401 || response.status === 403) {
        const errorBody = await response.text();
        throw new Error(
          `OpenAI authentication failed (HTTP ${response.status}). Check your OpenAI API key in Settings.`
        );
      }

      if (response.status === 429) {
        const errorBody = await response.text();
        throw new Error(
          `OpenAI rate limit or insufficient quota exceeded (HTTP 429). Note: OpenAI API requires a funded account with available credits.`
        );
      }

      if (response.status === 503 || response.status === 500) {
        const errorBody = await response.text();
        lastError = new Error(`OpenAI model "${targetModel}" is busy (HTTP ${response.status})`);
        if (attempt < MAX_ATTEMPTS) {
          const backoffMs = backoffDelayMs(attempt);
          onRetryNotice?.(
            `OpenAI server busy on ${targetModel}. Retrying in ${(backoffMs / 1000).toFixed(1)}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`
          );
          await waitForProvider(backoffMs, context.signal);
          continue;
        }
        throw new Error(
          `OpenAI model "${targetModel}" error (${response.status}) after ${MAX_ATTEMPTS} attempts.`
        );
      }

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`OpenAI API error (${response.status})`);
      }

      const data = await readProviderJsonBody(response, 'OpenAI', targetModel);
      const content = data?.choices?.[0]?.message?.content;
      return { data: parseModelJson(content, 'OpenAI'), effectiveModel: targetModel };
    } catch (err: any) {
      context.signal.throwIfAborted();
      lastError = err;
      const msg = (err.message || '').toLowerCase();
      if (msg.includes('suggestion:') || msg.includes('authentication') || msg.includes('quota')) {
        throw err;
      }
      if (attempt < MAX_ATTEMPTS && isRetryableProviderError(err)) {
        await waitForProvider(backoffDelayMs(attempt), context.signal);
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error(`Failed to call OpenAI model "${targetModel}".`);
}

/**
 * Dispatch call to selected AI provider using validated model from registry.
 */
async function dispatchAiCall(
  provider: AiProvider,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  onRetryNotice: ((notice: string) => void) | undefined,
  datasetRows: Record<string, any>[],
  schemaColumns: string[],
  signal: AbortSignal
): Promise<{ data: any; effectiveModel: string }> {
  await throttleDispatch(signal, onRetryNotice);

  // Validate model capability
  const capCheck = validateModelCapabilities(model, ['sqlGeneration']);
  if (!capCheck.valid) {
    console.warn(`[QueryMind] Model "${model}" capability warning: missing ${capCheck.missing.join(', ')}`);
  }

  const context: ProviderRequestContext = { systemPrompt, userPrompt, schemaColumns, datasetRows, signal };
  if (provider === 'groq') {
    return callGroq(apiKey, model, systemPrompt, userPrompt, onRetryNotice, context);
  }
  if (provider === 'openai') {
    return callOpenAi(apiKey, model, systemPrompt, userPrompt, onRetryNotice, context);
  }
  return callGemini(apiKey, model, `${systemPrompt}\n\n${userPrompt}`, onRetryNotice, context);
}


/**
 * Generates relevant suggested questions for a dataset based on semantic schema.
 */
export function generateDatasetSuggestions(dataset: Dataset): string[] {
  const cols = dataset.columns.map((c) => c.name.toLowerCase());
  const suggestions: string[] = [];

  if (cols.includes('mrr') && cols.includes('churn_status')) {
    suggestions.push('Show top 5 Enterprise customers by lost MRR with high support tickets');
    suggestions.push('What is the average MRR and total customers grouped by plan tier?');
    suggestions.push('Which customers are At-Risk or Churned with NPS score under 6?');
    suggestions.push('Show total MRR and active users by industry ordered by revenue');
    suggestions.push('List all Enterprise customers active with over 200 users and 0-3 tickets');
  } else if (cols.includes('sales') && cols.includes('profit')) {
    suggestions.push('What is the most sold product in each region for the ecommerce dataset?');
    suggestions.push('What are the top 5 most profitable products in Technology?');
    suggestions.push('Show total sales, total profit, and average discount by region');
    suggestions.push('Which products have negative profit margin due to high discounts?');
    suggestions.push('Compare category performance: sum of sales and profit sorted by profit desc');
  } else {
    const numCol = dataset.columns.find((c) => c.type === 'number');
    const strCol = dataset.columns.find((c) => c.type === 'string');
    if (numCol && strCol) {
      suggestions.push(`What is the total and average ${numCol.name} grouped by ${strCol.name}?`);
      suggestions.push(`Show top 5 ${strCol.name} records ordered by ${numCol.name} descending`);
    } else {
      suggestions.push(`Show a summary of the first 10 rows in ${dataset.tableName}`);
    }
  }

  return suggestions;
}

/**
 * Checks if a natural language question is semantically out of bounds of the dataset.
 */
export function isQueryOutOfScope(
  question: string,
  dataset: Dataset
): { outOfScope: boolean; reason?: string } {
  const q = question.toLowerCase().trim();
  const cleanQ = q.replace(/[^a-z0-9\s]/g, ' ');
  const words = cleanQ.split(/\s+/).filter((w) => w.length > 1);

  // "Who are the top customers by MRR?" opens like trivia but names the table's own columns.
  const GENERIC_COLUMN_PARTS = new Set(['id', 'name', 'date', 'pct', 'usd', 'num', 'value', 'type', 'code', 'status']);
  const columnParts = new Set<string>();
  dataset.columns.forEach((c) =>
    c.name.toLowerCase().split(/[^a-z0-9]/).forEach((part) => {
      if (part.length > 2 && !GENERIC_COLUMN_PARTS.has(part)) columnParts.add(part);
    })
  );
  const namesOwnColumn = words.some(
    (w) => columnParts.has(w) || columnParts.has(w.replace(/es$/, '')) || columnParts.has(w.replace(/s$/, ''))
  );

  // 1. Explicit Out-of-Domain Keywords & Patterns (Memes, Trivia, Politics, General knowledge)
  const outOfScopeRules: { pattern: RegExp; reason: string; yieldsToColumnReference?: boolean }[] = [
    {
      pattern: /\b(meme|memes|viral|trending|slang|brainrot|skibidi|gyatt|rizz|sigma|copypasta|joke|prank|tiktok|youtube|instagram|twitter|reddit|twitch|discord)\b/i,
      reason: 'This question asks about internet culture, memes, social media trends, or slang, which are not present in this dataset.',
    },
    {
      pattern: /\b(president|prime minister|senator|congress|white house|election|democrat|republican|governor|monarch|ruler|vice president|parliament|government)\b/i,
      reason: 'This question asks about political leadership or government affairs, which are not recorded in this dataset.',
    },
    {
      pattern: /\b(weather|temperature|forecast|rain|climate|humidity|snow|sunny|storm|monsoon)\b/i,
      reason: 'This question requests meteorological or weather measurements, which are not present in this dataset.',
    },
    {
      pattern: /\b(capital of|population of|continent|mount everest|ocean|river|geography|planet|solar system)\b/i,
      reason: 'This question requests general geographic or astronomical facts not stored in this dataset.',
    },
    {
      pattern: /\b(super bowl|world cup|olympics|nba|fifa|ipl|tournament|championship|premier league|formula 1|f1|messi|ronaldo)\b/i,
      reason: 'This question asks about sports competitions, athletes, or tournament scores, which are outside this dataset.',
    },
    {
      pattern: /\b(movie|actor|actress|director|song|singer|celebrity|album|box office|grammy|oscar|hollywood|bollywood|netflix|film|cinema)\b/i,
      reason: 'This question asks about entertainment, celebrities, or pop culture media, which are not tracked in this table.',
    },
    {
      pattern: /\b(recipe|ingredients|cooking|calories|food|baking|restaurant|cuisine)\b/i,
      reason: 'This question requests culinary recipes or nutritional data not present in this dataset.',
    },
    {
      pattern: /\b(quantum|relativity|gravity|photosynthesis|biology|chemistry|physics|math theorem|calculus)\b/i,
      reason: 'This question requests general scientific or mathematical trivia not related to this dataset.',
    },
    {
      pattern: /^(who is|who was|who are|what is the meaning of|what does .* mean|what is .* about|explain .* to me|tell me about .*|how do i|why do|why is|write a poem|translate)/i,
      reason: 'This question requests general world knowledge, trivia, or conversational assistance rather than data analysis on the active table.',
      yieldsToColumnReference: true,
    },
  ];

  for (const { pattern, reason, yieldsToColumnReference } of outOfScopeRules) {
    if (yieldsToColumnReference && namesOwnColumn) continue;
    if (pattern.test(q)) {
      return {
        outOfScope: true,
        reason: `${reason} Active dataset "${dataset.name}" focuses on ${dataset.columns.map((c) => c.name).slice(0, 5).join(', ')}.`,
      };
    }
  }

  // 2. Analytical & Exploration Intent Words
  const validExplorationTokens = new Set([
    'table', 'dataset', 'data', 'row', 'rows', 'record', 'records', 'column', 'columns', 'schema',
    'overview', 'summary', 'summarize', 'all', 'sample', 'first', 'last', 'preview',
    'top', 'bottom', 'highest', 'lowest', 'max', 'maximum', 'min', 'minimum',
    'average', 'avg', 'sum', 'total', 'count', 'how many', 'distribution', 'breakdown',
    'group', 'grouped', 'compare', 'filter', 'where', 'order', 'sort', 'list', 'show', 'find', 'which',
    'percentage', 'ratio', 'rate', 'metric', 'metrics', 'most', 'sold', 'selling', 'product', 'item'
  ]);

  // Extract column names, parts of column names, and sample values from dataset
  const datasetTokens = new Set<string>();
  dataset.columns.forEach((c) => {
    const name = c.name.toLowerCase();
    datasetTokens.add(name);
    name.split(/[^a-z0-9]/).forEach((part) => {
      if (part.length > 2) datasetTokens.add(part);
    });

    if (c.sampleValues) {
      c.sampleValues.forEach((val) => {
        if (typeof val === 'string' && val.length < 30) {
          val.toLowerCase().split(/\s+/).forEach((vp) => {
            if (vp.length > 2) datasetTokens.add(vp);
          });
        }
      });
    }
  });

  // Common analytical synonyms
  const saasSynonyms = [
    'customer', 'customers', 'client', 'clients', 'company', 'companies', 'account', 'accounts',
    'mrr', 'revenue', 'money', 'dollar', 'dollars', 'income', 'sales', 'profit', 'arr', 'pricing', 'price',
    'churn', 'churned', 'lost', 'cancel', 'cancelled', 'canceling', 'retention', 'attrition', 'risk', 'at-risk',
    'plan', 'plans', 'tier', 'tiers', 'subscription', 'subscriptions', 'package',
    'user', 'users', 'seat', 'seats', 'active', 'inactive', 'license', 'licenses',
    'nps', 'score', 'scores', 'rating', 'feedback', 'satisfaction',
    'ticket', 'tickets', 'support', 'issue', 'issues', 'complaint', 'complaints',
    'industry', 'industries', 'sector', 'sectors', 'vertical', 'verticals',
    'signup', 'signups', 'date', 'dates', 'month', 'months', 'year', 'years', 'cohort',
    'order', 'orders', 'product', 'products', 'item', 'items', 'goods', 'sku', 'skus',
    'category', 'categories', 'region', 'regions', 'geography', 'territory', 'territories',
    'discount', 'discounts', 'margin', 'margins', 'volume', 'volumes', 'unit', 'units', 'quantity'
  ];
  saasSynonyms.forEach((s) => datasetTokens.add(s));

  // Check if at least ONE meaningful word in the question matches the dataset tokens or analytical exploration words
  let hasDatasetMatch = false;
  let hasExplorationMatch = false;

  for (const word of words) {
    if (datasetTokens.has(word)) {
      hasDatasetMatch = true;
      break;
    }
    if (validExplorationTokens.has(word)) {
      hasExplorationMatch = true;
    }
  }

  // If the query has neither a dataset column/metric match nor a clear generic table exploration intent:
  if (!hasDatasetMatch && !hasExplorationMatch) {
    return {
      outOfScope: true,
      reason: `No relevant metrics, columns, or dimensions matching "${question}" were found in "${dataset.name}". Please ask an analytical question referring to the available columns.`,
    };
  }

  return { outOfScope: false };
}

/**
 * Deterministic Curated Queries for instant, verified exploration.
 *
 * These templates only provide SQL + a QueryPlan derived from the dataset's ACTUAL
 * schema. They never ship dataset-specific narratives: every insight shown to the user
 * is generated afterwards from the real DuckDB execution results by
 * processNaturalLanguageQuery (which routes curated SQL through the same
 * execute -> validate -> evidence-summarize contract as the LLM path).
 *
 * Match requirements:
 * - Trigger phrases use anchored word boundaries (never bare substrings like "top").
 * - Every column referenced by the template SQL must exist in the active dataset.
 * - A matching column name alone never establishes dataset identity; templates whose
 *   phrasing implies the shipped sample datasets additionally require those datasets.
 */
export function getDeterministicCuratedQuery(question: string, dataset: Dataset): AiQueryResult | null {
  const normQ = question.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  const t = dataset.tableName;

  const hasColumns = (...names: string[]) =>
    names.every((n) => dataset.columns.some((c) => c.name.toLowerCase() === n.toLowerCase()));

  const placeholderInsight: QueryInsight = { summary: '', highlights: [] };

  // 1. E-COMMERCE: "what is the most sold product in each region" and its direct verified paraphrases
  const isMostSoldProductPerRegion =
    (normQ.includes('most sold product') || normQ.includes('top product') || normQ.includes('top selling product') || normQ.includes('highest volume product') || normQ.includes('highest sold product')) &&
    (normQ.includes('each region') || normQ.includes('every region') || normQ.includes('per region') || normQ.includes('by region'));

  if (hasColumns('product', 'region', 'quantity', 'sales', 'profit', 'category')) {
    if (isMostSoldProductPerRegion) {
      const plan: QueryPlan = {
        intent: 'top_n_per_group',
        partition_by: ['region'],
        item_entity: 'product',
        dimensions: ['region', 'product', 'category'],
        metric: 'quantity',
        aggregation: 'SUM',
        ranking_direction: 'DESC',
        limit: 1,
        scope: 'each_group',
        explanation: 'Find the top-selling product in each distinct region based on cumulative units sold.',
      };

      const sql = `WITH ranked_regional_products AS (
  SELECT
    region,
    product,
    category,
    SUM(quantity) AS total_units_sold,
    ROUND(SUM(sales), 0) AS total_sales,
    ROUND(SUM(profit), 0) AS total_profit,
    ROW_NUMBER() OVER (PARTITION BY region ORDER BY SUM(quantity) DESC) AS rank
  FROM ${t}
  GROUP BY region, product, category
)
SELECT region, product, category, total_units_sold, total_sales, total_profit
FROM ranked_regional_products
WHERE rank = 1
ORDER BY total_units_sold DESC`;

      return {
        sql,
        queryPlan: plan,
        reasoningSteps: [
          { title: 'Intent Understanding', detail: 'Grouped ranking requested: Top 1 product per geographic region', status: 'done' },
          { title: 'Semantic Schema Grounding', detail: `Partition column: region, Item entity: product, Metric: quantity (units sold)`, status: 'done' },
          { title: 'SQL Blueprint Mapping', detail: 'Formulated CTE with ROW_NUMBER() OVER (PARTITION BY region ORDER BY SUM(quantity) DESC)', status: 'done' },
        ],
        insight: placeholderInsight,
        chartSuggestion: {
          type: 'bar',
          xAxisKey: 'region',
          yAxisKey: 'total_units_sold',
          title: 'Most Sold Product in Each Region (Units Sold)',
        },
        usedProvider: 'QueryMind Verified Blueprint Engine',
      };
    }

    // Top 5 profitable products in a category (e.g. Technology)
    const categoryMatch = normQ.match(/\b(?:in|for)\s+([a-z]+)\s*$/)?.[1];
    if (/\btop\s*(5|five)\b/.test(normQ) && normQ.includes('profit') && categoryMatch && dataset.columns.some((c) => c.name === 'category')) {
      // Only trigger when the trailing word is an actual category value present in the data
      // (unknown categories are left to the LLM path so users get a real answer, not an empty table).
      const categoryValues = dataset.columns.find((c) => c.name === 'category')?.sampleValues || [];
      const knownCategory = categoryValues.some((v) => typeof v === 'string' && v.toLowerCase() === categoryMatch);
      if (knownCategory) {
        const sql = `SELECT product, category, ROUND(SUM(sales), 0) AS total_sales, ROUND(SUM(profit), 0) AS total_profit, ROUND((SUM(profit) / SUM(sales)) * 100, 1) AS margin_pct FROM ${t} WHERE category = '${categoryMatch.charAt(0).toUpperCase() + categoryMatch.slice(1)}' GROUP BY product, category ORDER BY total_profit DESC LIMIT 5`;
        return {
          sql,
          queryPlan: {
            intent: 'ranking',
            dimensions: ['product', 'category'],
            metric: 'profit',
            aggregation: 'SUM',
            ranking_direction: 'DESC',
            limit: 5,
            explanation: `Top 5 products in category "${categoryMatch}" by net profit`,
          },
          reasoningSteps: [
            { title: 'Intent Understanding', detail: `Ranked top 5 products in the "${categoryMatch}" category by profit`, status: 'done' },
            { title: 'Semantic Schema Grounding', detail: `Filter: category = ${categoryMatch}, Metric: profit`, status: 'done' },
            { title: 'SQL Blueprint Mapping', detail: 'Standard filtered top-N ranking with margin calculation', status: 'done' },
          ],
          insight: placeholderInsight,
          chartSuggestion: {
            type: 'horizontal_bar',
            xAxisKey: 'product',
            yAxisKey: 'total_profit',
            title: `Top 5 Most Profitable ${categoryMatch.charAt(0).toUpperCase() + categoryMatch.slice(1)} Products`,
            categoryLabel: 'Product',
            metricLabel: 'Total Profit',
          },
          usedProvider: 'QueryMind Verified Blueprint Engine',
        };
      }
    }

    // Total sales, total profit, and average discount by region
    if (hasColumns('discount_pct') && normQ.includes('sales') && normQ.includes('profit') && normQ.includes('region')) {
      const sql = `SELECT region, ROUND(SUM(sales), 0) AS total_sales, ROUND(SUM(profit), 0) AS total_profit, ROUND(AVG(discount_pct) * 100, 1) AS avg_discount_pct FROM ${t} GROUP BY region ORDER BY total_sales DESC`;
      return {
        sql,
        queryPlan: {
          intent: 'aggregate_by_dimension',
          dimensions: ['region'],
          metric: 'sales',
          aggregation: 'SUM',
          explanation: 'Regional aggregation of sales, profit, and discount rate',
        },
        reasoningSteps: [
          { title: 'Intent Understanding', detail: 'Regional breakdown of sales, profit, and discount rate', status: 'done' },
          { title: 'Semantic Schema Grounding', detail: 'Dimension: region, Metrics: sales, profit, discount_pct', status: 'done' },
          { title: 'SQL Blueprint Mapping', detail: 'Standard multi-metric GROUP BY region', status: 'done' },
        ],
        insight: placeholderInsight,
        chartSuggestion: {
          type: 'bar',
          xAxisKey: 'region',
          yAxisKey: 'total_profit',
          title: 'Total Profit by Region',
          categoryLabel: 'Region',
          metricLabel: 'Total Profit',
        },
        usedProvider: 'QueryMind Verified Blueprint Engine',
      };
    }

    // Products whose cumulative profit is negative, with the discounting that explains it
    const isUnprofitableProductAudit =
      normQ.includes('product') &&
      !normQ.includes('order') &&
      normQ.includes('profit') &&
      normQ.includes('discount') &&
      (normQ.includes('negative') || normQ.includes('loss') || normQ.includes('unprofitable'));

    if (isUnprofitableProductAudit && hasColumns('discount_pct')) {
      const sql = `SELECT product, category, COUNT(*) AS order_count, ROUND(SUM(sales), 2) AS total_sales, ROUND(SUM(profit), 2) AS total_profit, ROUND((SUM(profit) / NULLIF(SUM(sales), 0)) * 100, 1) AS margin_pct, ROUND(AVG(discount_pct) * 100, 1) AS avg_discount_pct FROM ${t} GROUP BY product, category HAVING SUM(profit) < 0 ORDER BY total_profit ASC`;
      return {
        sql,
        queryPlan: {
          intent: 'aggregate_by_dimension',
          dimensions: ['product', 'category'],
          metric: 'profit',
          aggregation: 'SUM',
          explanation: 'Loss-making products with their margin and average discount rate',
        },
        reasoningSteps: [
          { title: 'Intent Understanding', detail: 'Loss audit requested: products whose summed profit is negative', status: 'done' },
          { title: 'Semantic Schema Grounding', detail: 'Dimension: product + category, Metrics: profit, sales, discount_pct', status: 'done' },
          { title: 'SQL Blueprint Mapping', detail: 'GROUP BY product, category with HAVING SUM(profit) < 0', status: 'done' },
        ],
        insight: placeholderInsight,
        chartSuggestion: {
          type: 'horizontal_bar',
          xAxisKey: 'product',
          yAxisKey: 'total_profit',
          title: 'Products With Negative Total Profit',
          categoryLabel: 'Product',
          metricLabel: 'Total Profit',
        },
        usedProvider: 'QueryMind Verified Blueprint Engine',
      };
    }

    // Category performance comparison (sales, profit and margin per category)
    const isCategoryPerformance =
      normQ.includes('category') &&
      normQ.includes('profit') &&
      (normQ.includes('performance') || normQ.includes('compare') || normQ.includes('breakdown'));

    if (isCategoryPerformance) {
      const sql = `SELECT category, COUNT(*) AS order_count, ROUND(SUM(sales), 2) AS total_sales, ROUND(SUM(profit), 2) AS total_profit, ROUND((SUM(profit) / NULLIF(SUM(sales), 0)) * 100, 1) AS margin_pct FROM ${t} GROUP BY category ORDER BY total_profit DESC`;
      return {
        sql,
        queryPlan: {
          intent: 'aggregate_by_dimension',
          dimensions: ['category'],
          metric: 'profit',
          aggregation: 'SUM',
          explanation: 'Category-level sales, profit and margin ranked by profit',
        },
        reasoningSteps: [
          { title: 'Intent Understanding', detail: 'Category comparison requested across sales and profit', status: 'done' },
          { title: 'Semantic Schema Grounding', detail: 'Dimension: category, Metrics: sales, profit', status: 'done' },
          { title: 'SQL Blueprint Mapping', detail: 'GROUP BY category ORDER BY total_profit DESC', status: 'done' },
        ],
        insight: placeholderInsight,
        chartSuggestion: {
          type: 'bar',
          xAxisKey: 'category',
          yAxisKey: 'total_profit',
          title: 'Category Performance By Total Profit',
          categoryLabel: 'Category',
          metricLabel: 'Total Profit',
        },
        usedProvider: 'QueryMind Verified Blueprint Engine',
      };
    }

    // Record-level discount/profit audit at an explicit discount threshold. The threshold is read
    // as a percent because normQ strips punctuation, so a fractional phrasing ("above 0.15") would
    // read as "0"; that case is left to the provider path instead of becoming a wrong filter.
    const discountThresholdMatch = normQ.match(
      /discount[a-z]*\s+(?:greater than|more than|above|over|exceeding|at least)\s+(\d+)/
    );
    const discountThresholdPct = discountThresholdMatch ? Number(discountThresholdMatch[1]) : NaN;
    const isOrderDiscountAudit =
      Number.isFinite(discountThresholdPct) &&
      discountThresholdPct > 0 &&
      normQ.includes('order') &&
      normQ.includes('profit') &&
      normQ.includes('negative');

    if (isOrderDiscountAudit && hasColumns('discount_pct', 'order_id')) {
      const threshold = discountThresholdPct / 100;
      const sql = `SELECT order_id, customer_name, region, category, product, order_date, sales, quantity, discount_pct, profit FROM ${t} WHERE discount_pct > ${threshold} AND profit < 0 ORDER BY profit ASC`;
      return {
        sql,
        queryPlan: {
          intent: 'filter_lookup',
          dimensions: ['order_id'],
          filters: [
            { column: 'discount_pct', operator: '>', value: threshold },
            { column: 'profit', operator: '<', value: 0 },
          ],
          explanation: `Orders discounted above ${(threshold * 100).toFixed(0)}% that sold at a loss`,
        },
        reasoningSteps: [
          { title: 'Intent Understanding', detail: 'Record-level audit requested: individual loss-making discounted orders', status: 'done' },
          { title: 'Semantic Schema Grounding', detail: `Conditions: discount_pct > ${threshold}, profit < 0`, status: 'done' },
          { title: 'SQL Blueprint Mapping', detail: 'Filtered detail rows without aggregation, worst margin first', status: 'done' },
        ],
        insight: placeholderInsight,
        usedProvider: 'QueryMind Verified Blueprint Engine',
      };
    }
  }

  // 2. SAAS: Prebuilt curated analytical queries (require the sample SaaS dataset identity)
  if (dataset.id === 'customers') {
    // 2-Count: "How many customers are in the dataset?"
    if (
      !normQ.includes('segment') &&
      !normQ.includes('tier') &&
      !normQ.includes('active') &&
      !normQ.includes('mrr') &&
      ((normQ.includes('how many') && normQ.includes('customer')) ||
       normQ.includes('count of customer') ||
       normQ.includes('total customer') ||
       normQ === 'how many customers are in the dataset' ||
       normQ === 'how many customers in dataset')
    ) {
      const sql = `SELECT COUNT(*) AS total_customers FROM ${t}`;
      return {
        sql,
        queryPlan: {
          intent: 'aggregate_by_dimension',
          dimensions: [],
          metric: 'customer_id',
          aggregation: 'COUNT',
          explanation: 'Count total distinct customers recorded in the dataset',
        },
        reasoningSteps: [
          { title: 'Intent Understanding', detail: 'Simple entity count requested: Total distinct customers in dataset', status: 'done' },
          { title: 'Semantic Schema Grounding', detail: 'Target entity: customer, Target metric: COUNT(*)', status: 'done' },
          { title: 'SQL Blueprint Formulation', detail: 'Formulated unconstrained count aggregation', status: 'done' },
        ],
        insight: placeholderInsight,
        usedProvider: 'QueryMind Verified Blueprint Engine',
      };
    }

    // 2-Total: "What is the total MRR across all customers?"
    if (
      hasColumns('mrr') &&
      (normQ.includes('total mrr') || (normQ.includes('total') && normQ.includes('mrr'))) &&
      !normQ.includes('tier') &&
      !normQ.includes('industry') &&
      !normQ.includes('segment')
    ) {
      const sql = `SELECT SUM(mrr) AS total_mrr FROM ${t}`;
      return {
        sql,
        queryPlan: {
          intent: 'aggregate_by_dimension',
          dimensions: [],
          metric: 'mrr',
          aggregation: 'SUM',
          explanation: 'Calculate cumulative Monthly Recurring Revenue across all customers',
        },
        reasoningSteps: [
          { title: 'Intent Understanding', detail: 'Cumulative revenue sum across customer base', status: 'done' },
          { title: 'Semantic Schema Grounding', detail: 'Metric: mrr, Aggregation: SUM(mrr)', status: 'done' },
          { title: 'SQL Blueprint Formulation', detail: 'Formulated total unconstrained sum aggregation', status: 'done' },
        ],
        insight: placeholderInsight,
        usedProvider: 'QueryMind Verified Blueprint Engine',
      };
    }

    // 2-Top5MRR: "Show the top 5 customers by MRR"
    if (
      hasColumns('company_name', 'plan_tier', 'mrr', 'churn_status', 'support_tickets') &&
      /\btop\s*(5|five)\b/.test(normQ) &&
      normQ.includes('customer') &&
      normQ.includes('mrr') &&
      !normQ.includes('lost') &&
      !normQ.includes('churn')
    ) {
      const sql = `SELECT company_name, plan_tier, mrr, churn_status, support_tickets FROM ${t} ORDER BY mrr DESC LIMIT 5`;
      return {
        sql,
        queryPlan: {
          intent: 'ranking',
          dimensions: ['company_name', 'plan_tier'],
          metric: 'mrr',
          ranking_direction: 'DESC',
          limit: 5,
          explanation: 'Rank top 5 customers by Monthly Recurring Revenue',
        },
        reasoningSteps: [
          { title: 'Intent Understanding', detail: 'Top 5 customer revenue ranking', status: 'done' },
          { title: 'Semantic Schema Grounding', detail: 'Entity: company_name, Metric: mrr DESC LIMIT 5', status: 'done' },
          { title: 'SQL Blueprint Formulation', detail: 'Formulated descending ranking query with LIMIT 5', status: 'done' },
        ],
        insight: placeholderInsight,
        chartSuggestion: {
          type: 'bar',
          xAxisKey: 'company_name',
          yAxisKey: 'mrr',
          title: 'Top 5 Customers by MRR',
          categoryLabel: 'Customer',
          metricLabel: 'MRR',
        },
        usedProvider: 'QueryMind Verified Blueprint Engine',
      };
    }

    // 2-ActivePct: "Calculate active customer percentages by segment"
    if (
      hasColumns('plan_tier', 'churn_status') &&
      normQ.includes('active') &&
      (normQ.includes('percent') || normQ.includes('percentage')) &&
      (normQ.includes('segment') || normQ.includes('tier'))
    ) {
      const sql = `SELECT plan_tier, COUNT(*) AS total_customers, SUM(CASE WHEN churn_status = 'Active' THEN 1 ELSE 0 END) AS active_customers, ROUND(SUM(CASE WHEN churn_status = 'Active' THEN 1.0 ELSE 0.0 END) / COUNT(*) * 100, 1) AS active_percentage FROM ${t} GROUP BY plan_tier ORDER BY active_percentage DESC`;
      return {
        sql,
        queryPlan: {
          intent: 'aggregate_by_dimension',
          dimensions: ['plan_tier'],
          metric: 'churn_status',
          explanation: 'Calculate active customer percentage and total counts by plan tier',
        },
        reasoningSteps: [
          { title: 'Intent Understanding', detail: 'Segment-level active customer percentage calculation', status: 'done' },
          { title: 'Semantic Schema Grounding', detail: 'Dimension: plan_tier, Condition: churn_status = "Active"', status: 'done' },
          { title: 'SQL Blueprint Formulation', detail: 'Formulated conditional ratio calculation grouped by plan tier', status: 'done' },
        ],
        insight: placeholderInsight,
        chartSuggestion: {
          type: 'bar',
          xAxisKey: 'plan_tier',
          yAxisKey: 'active_percentage',
          title: 'Active Customer Percentage by Plan Tier',
          categoryLabel: 'Plan Tier',
          metricLabel: 'Active %',
        },
        usedProvider: 'QueryMind Verified Blueprint Engine',
      };
    }

    // 2-MultiMetric: "For each segment, calculate active customer count and active MRR"
    if (
      hasColumns('plan_tier', 'churn_status', 'mrr') &&
      ((normQ.includes('active customer count') && normQ.includes('active mrr')) ||
       (normQ.includes('active count') && normQ.includes('active mrr')))
    ) {
      const sql = `SELECT plan_tier, COUNT(CASE WHEN churn_status = 'Active' THEN 1 END) AS active_customer_count, SUM(CASE WHEN churn_status = 'Active' THEN mrr ELSE 0 END) AS active_mrr, SUM(mrr) AS total_mrr FROM ${t} GROUP BY plan_tier ORDER BY active_mrr DESC`;
      return {
        sql,
        queryPlan: {
          intent: 'aggregate_by_dimension',
          dimensions: ['plan_tier'],
          metric: 'mrr',
          explanation: 'Calculate active customer count and active MRR by plan tier',
        },
        reasoningSteps: [
          { title: 'Intent Understanding', detail: 'Multi-metric breakdown: Active customers and active MRR by plan tier', status: 'done' },
          { title: 'Semantic Schema Grounding', detail: 'Dimension: plan_tier, Metrics: active customer count, active MRR', status: 'done' },
          { title: 'SQL Blueprint Formulation', detail: 'Formulated multi-aggregate conditional query', status: 'done' },
        ],
        insight: placeholderInsight,
        chartSuggestion: {
          type: 'bar',
          xAxisKey: 'plan_tier',
          yAxisKey: 'active_mrr',
          title: 'Active MRR by Plan Tier',
          categoryLabel: 'Plan Tier',
          metricLabel: 'Active MRR',
        },
        usedProvider: 'QueryMind Verified Blueprint Engine',
      };
    }

    // 2-Top2PerGroup: "Show the top two customers by MRR in each segment"
    if (
      hasColumns('company_name', 'plan_tier', 'mrr', 'churn_status') &&
      (normQ.includes('top two') || normQ.includes('top 2')) &&
      normQ.includes('mrr') &&
      (normQ.includes('segment') || normQ.includes('tier') || normQ.includes('each'))
    ) {
      const sql = `WITH ranked_customers AS (
  SELECT company_name, plan_tier, mrr, churn_status,
         ROW_NUMBER() OVER (PARTITION BY plan_tier ORDER BY mrr DESC) AS rank
  FROM ${t}
)
SELECT company_name, plan_tier, mrr, churn_status, rank
FROM ranked_customers
WHERE rank <= 2
ORDER BY plan_tier, rank`;
      return {
        sql,
        queryPlan: {
          intent: 'top_n_per_group',
          partition_by: ['plan_tier'],
          item_entity: 'company_name',
          dimensions: ['plan_tier', 'company_name'],
          metric: 'mrr',
          ranking_direction: 'DESC',
          limit: 2,
          scope: 'each_group',
          explanation: 'Identify the top 2 highest MRR customers within each plan tier using partitioned window ranking',
        },
        reasoningSteps: [
          { title: 'Intent Understanding', detail: 'Partitioned ranking: Top 2 accounts per plan tier', status: 'done' },
          { title: 'Semantic Schema Grounding', detail: 'Partition: plan_tier, Ranking Metric: mrr DESC', status: 'done' },
          { title: 'SQL Blueprint Formulation', detail: 'Formulated CTE with ROW_NUMBER() OVER (PARTITION BY plan_tier ORDER BY mrr DESC)', status: 'done' },
        ],
        insight: placeholderInsight,
        usedProvider: 'QueryMind Verified Blueprint Engine',
      };
    }

    // 2-HighTickets: "Find Enterprise customers with more than three support tickets"
    if (
      hasColumns('company_name', 'plan_tier', 'mrr', 'churn_status', 'support_tickets', 'nps_score') &&
      normQ.includes('enterprise') &&
      (normQ.includes('more than 3') || normQ.includes('more than three') || normQ.includes('> 3') || normQ.includes('>3')) &&
      (normQ.includes('ticket') || normQ.includes('support'))
    ) {
      const sql = `SELECT company_name, plan_tier, mrr, churn_status, support_tickets, nps_score FROM ${t} WHERE plan_tier = 'Enterprise' AND support_tickets > 3 ORDER BY support_tickets DESC`;
      return {
        sql,
        queryPlan: {
          intent: 'filter_lookup',
          dimensions: ['company_name', 'plan_tier'],
          metric: 'mrr',
          filters: [
            { column: 'plan_tier', operator: '=', value: 'Enterprise' },
            { column: 'support_tickets', operator: '>', value: 3 },
          ],
          explanation: 'Find Enterprise customers with elevated support ticket volume (> 3 tickets)',
        },
        reasoningSteps: [
          { title: 'Intent Understanding', detail: 'Filter Enterprise accounts with support tickets > 3', status: 'done' },
          { title: 'Semantic Schema Grounding', detail: 'Filters: plan_tier = "Enterprise" AND support_tickets > 3', status: 'done' },
          { title: 'SQL Blueprint Formulation', detail: 'Formulated filtered query ordered by support tickets descending', status: 'done' },
        ],
        insight: placeholderInsight,
        usedProvider: 'QueryMind Verified Blueprint Engine',
      };
    }

    // 2a. "Show me top 5 Enterprise customers by lost MRR with high support tickets"
    if (
      hasColumns('company_name', 'plan_tier', 'mrr', 'churn_status', 'support_tickets', 'nps_score') &&
      /\btop\b/.test(normQ) &&
      normQ.includes('enterprise') &&
      (normQ.includes('lost') || normQ.includes('churn')) &&
      (normQ.includes('ticket') || normQ.includes('support'))
    ) {
      const sql = `SELECT company_name, plan_tier, mrr AS lost_or_at_risk_mrr, churn_status, support_tickets, nps_score FROM ${t} WHERE plan_tier = 'Enterprise' AND churn_status IN ('Churned', 'At-Risk') AND support_tickets >= 5 ORDER BY mrr DESC LIMIT 5`;
      return {
        sql,
        queryPlan: {
          intent: 'ranking',
          dimensions: ['company_name', 'plan_tier'],
          metric: 'mrr',
          ranking_direction: 'DESC',
          limit: 5,
          filters: [
            { column: 'plan_tier', operator: '=', value: 'Enterprise' },
            { column: 'churn_status', operator: 'IN', value: ['Churned', 'At-Risk'] },
            { column: 'support_tickets', operator: '>=', value: 5 },
          ],
          explanation: 'Rank top 5 Enterprise accounts with lost/at-risk MRR and elevated support tickets (>= 5)',
        },
        reasoningSteps: [
          { title: 'Intent Understanding', detail: 'Rank top 5 Enterprise accounts with lost or at-risk MRR and high support ticket volume', status: 'done' },
          { title: 'Semantic Schema Grounding', detail: 'Applied: plan_tier = "Enterprise", churn_status IN ("Churned", "At-Risk"), support_tickets >= 5; Order: mrr DESC LIMIT 5', status: 'done' },
          { title: 'SQL Blueprint Formulation', detail: 'Formulated filtered ranking query with explicit threshold and limit', status: 'done' },
        ],
        insight: placeholderInsight,
        chartSuggestion: {
          type: 'horizontal_bar',
          xAxisKey: 'company_name',
          yAxisKey: 'lost_or_at_risk_mrr',
          title: 'Top Enterprise Customers with At-Risk MRR',
          categoryLabel: 'Company',
          metricLabel: 'At-Risk MRR',
          isAggregated: false,
        },
        usedProvider: 'QueryMind Verified Blueprint Engine',
      };
    }

    // 2b. "What is the average MRR and total customers grouped by plan tier?"
    if (hasColumns('plan_tier', 'mrr') && (normQ.includes('average mrr') || (normQ.includes('plan tier') && normQ.includes('mrr')))) {
      const sql = `SELECT plan_tier, COUNT(*) AS customer_count, ROUND(AVG(mrr), 0) AS avg_mrr, SUM(mrr) AS total_mrr FROM ${t} GROUP BY plan_tier ORDER BY total_mrr DESC`;
      return {
        sql,
        queryPlan: {
          intent: 'aggregate_by_dimension',
          dimensions: ['plan_tier'],
          metric: 'mrr',
          aggregation: 'SUM',
          explanation: 'Subscription plan tier revenue and customer distribution',
        },
        reasoningSteps: [
          { title: 'Intent Understanding', detail: 'Tier-based subscription metrics aggregation', status: 'done' },
          { title: 'Semantic Schema Grounding', detail: 'Dimension: plan_tier, Aggregates: COUNT, AVG(mrr), SUM(mrr)', status: 'done' },
          { title: 'SQL Blueprint Formulation', detail: 'Standard dimension aggregation blueprint grouped by plan tier', status: 'done' },
        ],
        insight: placeholderInsight,
        chartSuggestion: {
          type: 'donut',
          xAxisKey: 'plan_tier',
          yAxisKey: 'total_mrr',
          title: 'Total MRR Distribution by Plan Tier',
          categoryLabel: 'Plan Tier',
          metricLabel: 'Total MRR',
          isAggregated: true,
        },
        usedProvider: 'QueryMind Verified Blueprint Engine',
      };
    }

    // 2c. "Which customers are At-Risk or Churned with NPS score under 6?"
    if (
      hasColumns('company_name', 'plan_tier', 'mrr', 'churn_status', 'nps_score', 'support_tickets') &&
      /\bnps\b/.test(normQ) &&
      /(under|below|less than)\s*6/.test(normQ)
    ) {
      const sql = `SELECT company_name, plan_tier, mrr, churn_status, nps_score, support_tickets FROM ${t} WHERE churn_status IN ('Churned', 'At-Risk') AND nps_score < 6 ORDER BY mrr DESC`;
      return {
        sql,
        queryPlan: {
          intent: 'filter_lookup',
          dimensions: ['company_name', 'plan_tier'],
          metric: 'mrr',
          filters: [
            { column: 'churn_status', operator: 'IN', value: ['Churned', 'At-Risk'] },
            { column: 'nps_score', operator: '<', value: 6 },
          ],
          explanation: 'Find At-Risk or Churned accounts with detractor satisfaction scores (NPS < 6)',
        },
        reasoningSteps: [
          { title: 'Intent Understanding', detail: 'Filter customers with churn risk and detractor satisfaction scores (NPS < 6)', status: 'done' },
          { title: 'Semantic Schema Grounding', detail: 'Filters: churn_status IN ("Churned", "At-Risk") AND nps_score < 6', status: 'done' },
          { title: 'SQL Blueprint Formulation', detail: 'Filtered audit query ordered by MRR descending', status: 'done' },
        ],
        insight: placeholderInsight,
        usedProvider: 'QueryMind Verified Blueprint Engine',
      };
    }

    // 2d. "Show total MRR and active users by industry ordered by revenue"
    if (
      hasColumns('industry', 'mrr', 'active_users') &&
      normQ.includes('industry') &&
      (normQ.includes('revenue') || normQ.includes('mrr') || normQ.includes('ordered'))
    ) {
      const sql = `SELECT industry, COUNT(*) AS customer_count, SUM(mrr) AS total_mrr, SUM(active_users) AS total_active_users, ROUND(AVG(mrr), 0) AS avg_mrr FROM ${t} GROUP BY industry ORDER BY total_mrr DESC`;
      return {
        sql,
        queryPlan: {
          intent: 'aggregate_by_dimension',
          dimensions: ['industry'],
          metric: 'mrr',
          aggregation: 'SUM',
          explanation: 'Aggregate MRR and active users grouped by industry vertical',
        },
        reasoningSteps: [
          { title: 'Intent Understanding', detail: 'Industry vertical breakdown of revenue and user adoption', status: 'done' },
          { title: 'Semantic Schema Grounding', detail: 'Dimension: industry, Metrics: SUM(mrr), SUM(active_users), COUNT(*)', status: 'done' },
          { title: 'SQL Blueprint Formulation', detail: 'Standard dimension aggregation grouped by industry', status: 'done' },
        ],
        insight: placeholderInsight,
        chartSuggestion: {
          type: 'bar',
          xAxisKey: 'industry',
          yAxisKey: 'total_mrr',
          title: 'Total MRR by Industry Vertical',
          categoryLabel: 'Industry',
          metricLabel: 'Total MRR',
          isAggregated: true,
        },
        usedProvider: 'QueryMind Verified Blueprint Engine',
      };
    }

    // 2e. "List all Enterprise customers active with over 200 users and 0-3 tickets"
    if (
      hasColumns('company_name', 'industry', 'mrr', 'active_users', 'support_tickets', 'nps_score', 'plan_tier', 'churn_status') &&
      normQ.includes('enterprise') &&
      normQ.includes('active') &&
      (normQ.includes('200') || normQ.includes('users') || normQ.includes('ticket'))
    ) {
      const sql = `SELECT company_name, industry, mrr, active_users, support_tickets, nps_score FROM ${t} WHERE plan_tier = 'Enterprise' AND churn_status = 'Active' AND active_users > 200 AND support_tickets <= 3 ORDER BY mrr DESC`;
      return {
        sql,
        queryPlan: {
          intent: 'filter_lookup',
          dimensions: ['company_name', 'industry'],
          metric: 'mrr',
          filters: [
            { column: 'plan_tier', operator: '=', value: 'Enterprise' },
            { column: 'churn_status', operator: '=', value: 'Active' },
            { column: 'active_users', operator: '>', value: 200 },
            { column: 'support_tickets', operator: '<=', value: 3 },
          ],
          explanation: 'Identify high-adoption, low-friction healthy Enterprise accounts',
        },
        reasoningSteps: [
          { title: 'Intent Understanding', detail: 'Filter for active Enterprise accounts with high adoption (>200 users) and minimal support tickets (<= 3)', status: 'done' },
          { title: 'Semantic Schema Grounding', detail: 'Mapped columns: plan_tier = "Enterprise", churn_status = "Active", active_users > 200, support_tickets <= 3', status: 'done' },
          { title: 'SQL Blueprint Formulation', detail: 'Formulated multi-predicate filter query ordered by MRR descending', status: 'done' },
        ],
        insight: placeholderInsight,
        usedProvider: 'QueryMind Verified Blueprint Engine',
      };
    }
  }

  // 3. GENERIC DATASET EXPLORATION (Works deterministically for ANY uploaded CSV without an API key)
  const numCol = dataset.columns.find((c) => c.type === 'number');
  const strCol = dataset.columns.find((c) => c.type === 'string' && c.uniqueCount < dataset.rowCount) || dataset.columns.find((c) => c.type === 'string');

  // Summary / First 10 rows
  if (normQ.includes('summary of the first 10 rows') || normQ.includes('show first 10 rows') || normQ === 'preview dataset') {
    const sql = `SELECT * FROM ${t} LIMIT 10`;
    return {
      sql,
      queryPlan: {
        intent: 'overview',
        dimensions: [],
        explanation: `Preview of initial 10 records from ${dataset.name}`,
      },
      reasoningSteps: [
        { title: 'Schema Grounding', detail: `Examining uploaded dataset "${dataset.name}" with ${dataset.columns.length} columns`, status: 'done' },
        { title: 'Deterministic SQL Plan', detail: 'Previewing initial rows to inspect data structure', status: 'done' },
      ],
      insight: placeholderInsight,
      usedProvider: 'QueryMind Verified Blueprint Engine',
    };
  }

  // "What is the total and average <numCol> grouped by <catCol>?"
  if (numCol && strCol && normQ.includes('total and average') && normQ.includes('grouped by')) {
    const sql = `SELECT "${strCol.name}", COUNT(*) AS total_count, ROUND(SUM("${numCol.name}"), 2) AS total_${numCol.name}, ROUND(AVG("${numCol.name}"), 2) AS avg_${numCol.name} FROM ${t} GROUP BY "${strCol.name}" ORDER BY total_${numCol.name} DESC LIMIT 10`;
    return {
      sql,
      queryPlan: {
        intent: 'aggregate_by_dimension',
        dimensions: [strCol.name],
        metric: numCol.name,
        aggregation: 'SUM',
        explanation: `Total and average ${numCol.name} grouped by ${strCol.name}`,
      },
      reasoningSteps: [
        { title: 'Intent Understanding', detail: `Dimension aggregation: ${numCol.name} grouped by ${strCol.name}`, status: 'done' },
        { title: 'Schema Mapping', detail: `Dimension: "${strCol.name}", Metric: "${numCol.name}"`, status: 'done' },
        { title: 'SQL Blueprint Mapping', detail: 'Dimension aggregation with COUNT, SUM, and AVG', status: 'done' },
      ],
      insight: placeholderInsight,
      chartSuggestion: {
        type: 'bar',
        xAxisKey: strCol.name,
        yAxisKey: `total_${numCol.name}`,
        title: `Total ${numCol.name} by ${strCol.name}`,
      },
      usedProvider: 'QueryMind Verified Blueprint Engine',
    };
  }

  // "Show top 5 <strCol> records ordered by <numCol> descending"
  if (numCol && (normQ.includes('top 5') || normQ.includes('top 10')) && normQ.includes('ordered by') && normQ.includes('descending')) {
    const limit = normQ.includes('top 10') ? 10 : 5;
    const itemCol = strCol?.name || dataset.columns[0]?.name || 'record';
    const sql = `SELECT "${itemCol}", ROUND(SUM("${numCol.name}"), 2) AS total_${numCol.name} FROM ${t} GROUP BY "${itemCol}" ORDER BY total_${numCol.name} DESC LIMIT ${limit}`;
    return {
      sql,
      queryPlan: {
        intent: 'ranking',
        dimensions: [itemCol],
        metric: numCol.name,
        aggregation: 'SUM',
        limit,
        explanation: `Top ${limit} ${itemCol} records ordered by ${numCol.name} descending`,
      },
      reasoningSteps: [
        { title: 'Intent Understanding', detail: `Ranking top ${limit} ${itemCol} by ${numCol.name}`, status: 'done' },
        { title: 'Schema Mapping', detail: `Dimension: "${itemCol}", Measure: "${numCol.name}"`, status: 'done' },
        { title: 'SQL Blueprint Mapping', detail: `Global ranking blueprint with LIMIT ${limit}`, status: 'done' },
      ],
      insight: placeholderInsight,
      chartSuggestion: {
        type: 'bar',
        xAxisKey: itemCol,
        yAxisKey: `total_${numCol.name}`,
        title: `Top ${limit} ${itemCol} by ${numCol.name}`,
      },
      usedProvider: 'QueryMind Verified Blueprint Engine',
    };
  }

  return null;
}

/**
 * Computes dataset-level context for single-row filtered aggregates using
 * local DuckDB execution only (no additional LLM call). Returns undefined for
 * grouped queries or when the base metric column cannot be resolved safely.
 */
/**
 * Returns the stored numeric column a plain row-level "ORDER BY col LIMIT n" ranking was sorted on,
 * or undefined when the query aggregates, nests, joins or unions, because then the column's total
 * over the table is no longer the population the ranked rows were drawn from.
 */
export function rankedRawColumn(sql: string, columns: string[], dataset: Dataset): string | undefined {
  if (!/\bLIMIT\s+\d+/i.test(sql)) return undefined;
  if (/\b(GROUP\s+BY|JOIN|UNION|INTERSECT|EXCEPT|OVER|HAVING|DISTINCT)\b|\(\s*SELECT\b|^\s*WITH\b/i.test(sql)) return undefined;
  if (/\b(SUM|AVG|COUNT|MIN|MAX|MEDIAN)\s*\(/i.test(sql)) return undefined;
  const token = sql.match(/\bORDER\s+BY\s+"?([A-Za-z_][\w]*)"?/i)?.[1];
  if (!token) return undefined;
  const col = dataset.columns.find((c) => c.name.toLowerCase() === token.toLowerCase());
  if (!col || col.type !== 'number') return undefined;
  return columns.some((c) => c.toLowerCase() === col.name.toLowerCase()) ? col.name : undefined;
}

async function computeAuxiliaryStats(
  sql: string,
  columns: string[],
  dataset: Dataset,
  throwIfCancelled: () => void
): Promise<AuxStats | undefined> {
  const upper = sql.toUpperCase();
  const t = dataset.tableName;

  const rankedColumn = rankedRawColumn(sql, columns, dataset);
  if (rankedColumn) {
    const where = sql.match(/\bWHERE\b([\s\S]*?)(?:\bORDER\s+BY\b|\bLIMIT\b|;|$)/i)?.[1]?.trim();
    try {
      throwIfCancelled();
      const population = await executeClientSql(
        `SELECT SUM("${rankedColumn}") AS population_total, COUNT(*) AS population_count FROM ${t}${where ? ` WHERE ${where}` : ''}`,
        dataset
      );
      if (population.success && population.rows[0]) {
        return {
          rankedColumn,
          rankedPopulationTotal: Number(population.rows[0].population_total),
          rankedPopulationCount: Number(population.rows[0].population_count),
        };
      }
    } catch {}
    return undefined;
  }

  if (!upper.includes('WHERE') || upper.includes('GROUP BY') || columns.length !== 1) {
    return undefined;
  }

  const whereMatch = sql.match(/\bWHERE\b([\s\S]*?)(?:\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|;|$)/i);
  const whereClause = whereMatch?.[1]?.trim();
  if (!whereClause) return undefined;

  const alias = columns[0];
  // Prefer the aggregate argument parsed straight from the SQL (e.g. SUM(mrr_usd));
  // fall back to de-prefixing the returned alias (e.g. total_mrr -> mrr).
  const sumArgMatch = sql.match(/\bSUM\(\s*"?([A-Za-z_][\w]*)"?\s*\)/i);
  const parsedMetric = sumArgMatch?.[1];
  const aliasMetric = alias.replace(/^(total_|sum_)/i, '');
  const baseMetric =
    parsedMetric && dataset.columns.some((c) => c.name === parsedMetric)
      ? parsedMetric
      : dataset.columns.some((c) => c.name === aliasMetric)
      ? aliasMetric
      : undefined;
  const isSum = /^(total_|sum_)/i.test(alias) && baseMetric !== undefined;

  const stats: AuxStats = {};

  try {
    throwIfCancelled();
    if (isSum) {
      const totals = await executeClientSql(
        `SELECT SUM("${baseMetric}") AS overall_total, COUNT(*) AS overall_count FROM ${t}`,
        dataset
      );
      if (totals.success && totals.rows[0]) {
        stats.overallTotal = Number(totals.rows[0].overall_total);
        stats.overallCount = Number(totals.rows[0].overall_count);
      }
    } else {
      const counts = await executeClientSql(`SELECT COUNT(*) AS overall_count FROM ${t}`, dataset);
      if (counts.success && counts.rows[0]) {
        stats.overallCount = Number(counts.rows[0].overall_count);
      }
    }

    throwIfCancelled();
    const filtered = await executeClientSql(
      `SELECT COUNT(*) AS filtered_count FROM ${t} WHERE ${whereClause}`,
      dataset
    );
    if (filtered.success && filtered.rows[0]) {
      stats.filteredCount = Number(filtered.rows[0].filtered_count);
    }
  } catch {
    return undefined;
  }

  return Object.keys(stats).length > 0 ? stats : undefined;
}

/**
 * Main Agent Orchestrator for Natural Language Query Execution.
 * Implements the full Permanent NL->SQL Accuracy Architecture:
 * Intent Understanding -> Semantic Grounding -> Query Plan -> Blueprints -> SQL Guard ->
 * Intent Validator -> DuckDB Execution -> Result Validator -> Bounded Self-Correction (max 5 rounds) -> Answer.
 */
let processingEpoch = 0;
let activeProviderController: AbortController | undefined;

export function cancelActiveQueryProcessing(): void {
  processingEpoch += 1;
  activeProviderController?.abort(new Error('Query cancelled by user.'));
}

export async function processNaturalLanguageQuery(
  question: string,
  dataset: Dataset,
  keyConfig?: ApiKeyConfig,
  onStepProgress?: (step: ReasoningStep) => void
): Promise<AiQueryResult> {
  activeProviderController?.abort(new Error('Query superseded by a newer request.'));
  const providerController = new AbortController();
  activeProviderController = providerController;
  const startEpoch = processingEpoch;
  const throwIfCancelled = () => {
    providerController.signal.throwIfAborted();
    if (processingEpoch !== startEpoch) {
      throw new Error('Query cancelled by user.');
    }
  };

  const semanticSchema = profileDatasetSchema(dataset);

  // 1. Semantic Out-of-Scope Check (no SQL or trace generated for out-of-scope queries)
  const scopeCheck = isQueryOutOfScope(question, dataset);
  if (scopeCheck.outOfScope) {
    return {
      isOutOfScope: true,
      outOfScopeReason: scopeCheck.reason,
      suggestedQuestions: generateDatasetSuggestions(dataset),
      sql: '',
      reasoningSteps: [],
      insight: { summary: '', highlights: [] },
      usedProvider: 'QueryMind Semantic Scope Guard',
    };
  }

  // 2. Check for Verified Curated 1-Click Queries (available offline/keyless).
  // Curated SQL goes through the SAME contract as the LLM path: execute in DuckDB,
  // validate results, then synthesize the narrative from the actual returned rows.
  // A curated template that fails on this dataset falls through to the LLM path.
  const curatedMatch = getDeterministicCuratedQuery(question, dataset);
  if (curatedMatch) {
    if (onStepProgress) {
      onStepProgress({
        title: 'Verified Query Match',
        detail: 'Matched curated analytical blueprint. Executing against the dataset for verification...',
        status: 'running',
      });
    }

    const curatedExec = await executeValidatedSql(curatedMatch.sql, dataset, curatedMatch.queryPlan!, question);
    throwIfCancelled();
    if (curatedExec.success) {
        let curatedAux: AuxStats | undefined;
        try {
          curatedAux = await computeAuxiliaryStats(curatedMatch.sql, curatedExec.columns, dataset, throwIfCancelled);
        } catch {
          curatedAux = undefined;
        }

        throwIfCancelled();
        const curatedInsight = generateEvidenceBasedSummary({
          question,
          sql: curatedMatch.sql,
          status: 'verified',
          rows: curatedExec.rows,
          columns: curatedExec.columns,
          rowCount: curatedExec.rowCount,
          datasetName: dataset.name,
          tableName: dataset.tableName,
          queryPlan: curatedMatch.queryPlan,
          semanticSchema,
          executionTimeMs: curatedExec.executionTimeMs,
          auxStats: curatedAux,
        });

        const curatedChart = selectDeterministicVisualization(
          question,
          curatedMatch.queryPlan!,
          curatedExec.rows,
          curatedExec.columns,
          semanticSchema,
          curatedMatch.chartSuggestion
        );

        return {
          ...curatedMatch,
          status: 'verified',
          passedChecks: curatedExec.passedChecks,
          execution: curatedExec,
          insight: curatedInsight,
          chartSuggestion: curatedChart,
        };
    } else {
      console.warn('[QueryMind] Curated blueprint failed to execute; escalating to LLM path:', curatedExec.error);
    }

    if (onStepProgress) {
      onStepProgress({
        title: 'Curated Blueprint Incompatible',
        detail: 'The matched blueprint did not verify against this dataset. Switching to AI planning...',
        status: 'running',
      });
    }
  }

  // 3. Check for Undefined Metrics / Clarification Needs (Test Group C)
  const metricCheck = checkMetricAvailability(question, semanticSchema);
  if (!metricCheck.isAvailable) {
    return {
      status: 'needs_clarification',
      clarificationMessage: metricCheck.clarification,
      sql: '',
      reasoningSteps: [
        { title: 'Intent Understanding', detail: `Question specifies metric "${metricCheck.missingMetric}"`, status: 'done' },
        { title: 'Schema Grounding', detail: `Metric "${metricCheck.missingMetric}" is not directly defined in "${dataset.name}".`, status: 'done' },
        { title: 'Clarification Needed', detail: metricCheck.clarification!, status: 'waiting' },
      ],
      insight: {
        summary: `Clarification needed: "${metricCheck.missingMetric}" is not directly defined in ${dataset.name}.`,
        highlights: [
          `The dataset measures: ${dataset.columns.map((c) => c.name).join(', ')}.`,
          metricCheck.clarification || '',
        ].filter(Boolean),
        caveats: [metricCheck.caveat || metricCheck.clarification!],
        recommendedAction: (() => {
          const tokens = String(metricCheck.missingMetric || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
          const related = dataset.columns
            .filter((c) => tokens.some((t) => c.name.toLowerCase().includes(t)))
            .map((c) => c.name);
          return related.length > 0
            ? `Rephrase using a measure this dataset actually defines (related columns: ${related.join(', ')}).`
            : 'Rephrase the question using a measure this dataset actually defines.';
        })(),
      },
      usedProvider: 'QueryMind Contract Guard',
    };
  }

  // 3. Check API Key configuration
  const hasUserKey = keyConfig && keyConfig.key && keyConfig.key.trim().length > 0;
  const envKey = (import.meta as any).env?.VITE_GEMINI_API_KEY || (import.meta as any).env?.GEMINI_API_KEY;
  const activeKey = hasUserKey ? keyConfig.key : envKey;

  // 4. If No API Key configured for arbitrary custom queries:
  // Strictly DO NOT guess with greedy regex! Provide clear user guidance instead.
  if (!activeKey) {
    throw new Error(
      `An AI API Key (Google Gemini, Groq, or OpenAI) is required to analyze arbitrary natural language queries like "${question}". Please open Settings (gear icon in header) to provide your free API key, or select one of the verified sample queries below.`
    );
  }

  const provider: AiProvider = (hasUserKey && keyConfig?.provider) ? keyConfig.provider : DEFAULT_PROVIDER;
  const model = (hasUserKey && keyConfig?.model && getModel(provider, keyConfig.model))
    ? keyConfig.model
    : DEFAULT_MODELS[provider];
  const systemPrompt = buildPromptSystem(semanticSchema);

  // 5. Bounded Agent Self-Correction Loop (Up to MAX_AGENT_ROUNDS = 5)
  let lastErrors: string[] = [];
  let currentSql = '';
  let currentPlan: QueryPlan | undefined;

  for (let round = 1; round <= MAX_AGENT_ROUNDS; round++) {
    // Construct user prompt for current round
    let userPrompt = `NATURAL LANGUAGE QUESTION: "${question}"`;
    if (round > 1 && lastErrors.length > 0) {
      userPrompt += `\n\nPREVIOUS ATTEMPT FAILED VALIDATION (Round ${round - 1}/${MAX_AGENT_ROUNDS}):
Errors to fix:
${lastErrors.map((e) => `- ${redactCellValuesForEgress(e)}`).join('\n')}

Previous SQL was:
${currentSql}

Please adjust the Query Plan and rewrite the SQL to resolve all errors and satisfy DuckDB rules.`;
    }

    if (onStepProgress) {
      onStepProgress({
        title: round === 1 ? 'Intent & Plan Formulation' : `Refining Analysis (Round ${round}/${MAX_AGENT_ROUNDS})`,
        detail: `Analyzing question with ${provider.toUpperCase()} (${model})...`,
        status: 'running',
      });
    }

    // Call AI provider with retry notice handling
    const { data: aiJson, effectiveModel } = await dispatchAiCall(
      provider,
      activeKey,
      model,
      systemPrompt,
      userPrompt,
      (notice) => {
        if (onStepProgress) {
          onStepProgress({
            title: 'Transient Retry & Backoff',
            detail: notice,
            status: 'running',
          });
        }
      },
      dataset.data,
      dataset.columns.map((column) => column.name),
      providerController.signal
    );
    throwIfCancelled();

    // Check if AI determined question is out of scope
    if (aiJson?.isOutOfScope) {
      return {
        isOutOfScope: true,
        outOfScopeReason: aiJson.outOfScopeReason || 'Question is outside the dataset domain.',
        suggestedQuestions: aiJson.suggestedQuestions || generateDatasetSuggestions(dataset),
        sql: '',
        reasoningSteps: [],
        insight: { summary: '', highlights: [] },
        usedProvider: `${provider.toUpperCase()} (${effectiveModel || model || 'default'})`,
      };
    }

    currentSql = aiJson.sql || '';
    currentPlan = parseQueryPlan(aiJson.queryPlan, `Analysis plan for: ${question}`);

    if (!currentSql) {
      lastErrors = ['AI response did not provide a SQL statement.'];
      continue;
    }

    // Stage 1: Pre-Execution SQL Guard & Intent Validation
    if (onStepProgress) {
      onStepProgress({
        title: 'Validating Query Intent',
        detail: `Checking SQL against query plan: ${formatQueryPlanSummary(currentPlan)}`,
        status: 'running',
      });
    }

    // Stage 2: DuckDB Execution in Browser
    if (onStepProgress) {
      onStepProgress({
        title: 'DuckDB Engine Execution',
        detail: 'Executing validated query locally in browser...',
        status: 'running',
      });
    }

    const execResult = await executeValidatedSql(currentSql, dataset, currentPlan, question);
    throwIfCancelled();
    if (!execResult.success) {
      lastErrors = [execResult.error || 'Query verification failed.'];
      if (execResult.error?.includes('Query returned 0 rows')) break;
      continue;
    }

    // All validations passed!
    if (onStepProgress) {
      onStepProgress({
        title: 'Answer Verified',
        detail: `Successfully verified query intent and execution in ${round} round(s).`,
        status: 'done',
      });
    }

    const reasoningSteps: ReasoningStep[] = [
      {
        title: 'Intent Understanding',
        detail: `Understood goal: "${question}" -> ${formatQueryPlanSummary(currentPlan)}`,
        status: 'done',
      },
      {
        title: 'Semantic Schema Grounding',
        detail: `Mapped columns from table "${dataset.tableName}" (${dataset.columns.length} columns, ${dataset.rowCount} rows)`,
        status: 'done',
      },
      {
        title: 'SQL Blueprint Formulation',
        detail: `Formulated DuckDB query with safety and intent validation passed.`,
        status: 'done',
      },
      {
        title: 'Execution & Result Verification',
        detail: `DuckDB execution verified: ${execResult.rowCount} rows returned in ${execResult.executionTimeMs}ms with 0 constraint violations.`,
        status: 'done',
      },
    ];

    const deterministicChart = selectDeterministicVisualization(
      question,
      currentPlan,
      execResult.rows,
      execResult.columns,
      semanticSchema,
      aiJson.chartSuggestion
    );

    let auxStats: AuxStats | undefined;
    try {
      auxStats = await computeAuxiliaryStats(currentSql, execResult.columns, dataset, throwIfCancelled);
    } catch {
      auxStats = undefined;
    }

    throwIfCancelled();
    const verifiedInsight = generateEvidenceBasedSummary({
      question,
      sql: currentSql,
      status: 'verified',
      rows: execResult.rows,
      columns: execResult.columns,
      rowCount: execResult.rowCount,
      datasetName: dataset.name,
      tableName: dataset.tableName,
      queryPlan: currentPlan,
      semanticSchema,
      executionTimeMs: execResult.executionTimeMs,
      passedChecks: execResult.passedChecks,
      llmInsight: aiJson.insight,
      auxStats,
    });

    // Save successful query to zero-backend sandboxed local library
    try {
      const storage = new LocalQueryStorage();
      storage.saveSuccessfulQuery(
        question,
        dataset.columns.map((c) => c.name),
        currentSql
      );
    } catch (err) {
      console.warn('[QueryMind] Local storage save skipped:', err);
    }

    return {
      sql: currentSql,
      status: 'verified',
      passedChecks: execResult.passedChecks,
      execution: execResult,
      queryPlan: currentPlan,
      validationRounds: round,
      reasoningSteps: aiJson.reasoningSteps && aiJson.reasoningSteps.length > 0 ? aiJson.reasoningSteps : reasoningSteps,
      insight: verifiedInsight,
      chartSuggestion: deterministicChart,
      usedProvider: `${provider.toUpperCase()} (${effectiveModel || model})`,
    };
  }

  // If loop exhausted MAX_AGENT_ROUNDS without passing:
  // Fall back to deterministic plan construction from the latest parsed plan.
  // The fallback must satisfy the same contract as the primary path: execute
  // through the client-side engine, validate the result, and synthesize the
  // insight from the real returned rows. Unvalidated fallback output is never
  // returned as a successful answer.
  if (currentPlan) {
    // Only a plan whose columns all exist in the active schema can be a faithful
    // deterministic restatement of the request; otherwise the fallback would answer
    // a different question than the one the user asked.
    const schemaColumns = new Set(dataset.columns.map((c) => c.name.toLowerCase()));
    const planColumns = [
      ...(currentPlan.dimensions ?? []),
      ...(currentPlan.partition_by ?? []),
      currentPlan.item_entity ?? '',
      currentPlan.metric ?? '',
      ...(currentPlan.filters ?? []).map((f) => f.column),
    ].map((c) => String(c).toLowerCase()).filter(Boolean);
    const unknownColumns = [...new Set(planColumns.filter((c) => !schemaColumns.has(c)))];
    const planCarriesAnalysis =
      (currentPlan.dimensions?.length ?? 0) > 0 ||
      Boolean(currentPlan.metric) ||
      Boolean(currentPlan.item_entity) ||
      (currentPlan.partition_by?.length ?? 0) > 0 ||
      (currentPlan.filters?.length ?? 0) > 0;

    if (!planCarriesAnalysis) {
      lastErrors = [...lastErrors, 'Blueprint fallback skipped: the last plan carried no columns or filters, so it could not answer this question.'];
    } else if (unknownColumns.length > 0) {
      lastErrors = [...lastErrors, `Blueprint fallback skipped: plan references columns absent from this dataset (${unknownColumns.join(', ')}).`];
    } else {
    let fallbackSql = '';
    try {
      fallbackSql = constructSqlFromPlan(currentPlan, dataset.tableName);
    } catch (err: any) {
      lastErrors = [...lastErrors, `Blueprint fallback skipped: ${err?.message || 'plan is not executable'}`];
    }
    if (fallbackSql) {
    throwIfCancelled();
    const execFallback = await executeValidatedSql(fallbackSql, dataset, currentPlan, question);
    throwIfCancelled();
    if (execFallback.success) {
        let fallbackAux: AuxStats | undefined;
        try {
          fallbackAux = await computeAuxiliaryStats(fallbackSql, execFallback.columns, dataset, throwIfCancelled);
        } catch {
          fallbackAux = undefined;
        }

        throwIfCancelled();
        const fallbackInsight = generateEvidenceBasedSummary({
          question,
          sql: fallbackSql,
          status: 'verified',
          rows: execFallback.rows,
          columns: execFallback.columns,
          rowCount: execFallback.rowCount,
          datasetName: dataset.name,
          tableName: dataset.tableName,
          queryPlan: currentPlan,
          semanticSchema,
          executionTimeMs: execFallback.executionTimeMs,
          passedChecks: execFallback.passedChecks,
          auxStats: fallbackAux,
        });

        return {
          sql: fallbackSql,
          status: 'verified',
          passedChecks: execFallback.passedChecks,
          execution: execFallback,
          queryPlan: currentPlan,
          validationRounds: MAX_AGENT_ROUNDS,
          reasoningSteps: [
            { title: 'Intent Understanding', detail: formatQueryPlanSummary(currentPlan), status: 'done' },
            { title: 'Autonomous Blueprint Fallback', detail: 'Constructed canonical DuckDB SQL from intermediate plan after correction rounds', status: 'done' },
            { title: 'Execution Verification', detail: `DuckDB returned ${execFallback.rowCount} rows; result validation passed.`, status: 'done' },
          ],
          insight: fallbackInsight,
          chartSuggestion: selectDeterministicVisualization(question, currentPlan, execFallback.rows, execFallback.columns, semanticSchema),
          usedProvider: `${provider.toUpperCase()} (Autonomous Blueprint Fallback)`,
        };
    } else {
      lastErrors = [...lastErrors, `Blueprint fallback execution failed: ${execFallback.error}`];
    }
    }
    }
  }

  throw new Error(
    `Query generation could not satisfy accuracy constraints after ${MAX_AGENT_ROUNDS} self-correction rounds: ${lastErrors.join('; ')}`
  );
}

/**
 * Modular Two-Stage Double-Pass Service Architecture.
 */
export class AiQueryMindService {
  private storage = new LocalQueryStorage();
  private matcher = new TemplateMatcher();

  /**
   * Turn 1: Build a complete declarative schema block + SQL Statement Generator
   */
  public buildGenerationPayload(userPrompt: string, profile: any, modelTier?: string): string {
    const matchedTemplates = this.matcher.getTopKMatches(userPrompt, 2);
    const structuralSavedMemory = this.storage.getRelevantUserTemplates(profile.columnNames, userPrompt);

    // Build Schema Metadata Context block
    const schemaContextString = JSON.stringify(profile.columns, null, 2);

    let systemPrompt = `You are a strict deterministic DuckDB-WASM SQL Engineering Agent.
Your task is to translate natural language queries into executable SELECT statements.

Target Schema Profile:
${schemaContextString}

DuckDB Execution Rules:
- Case-Insensitive String matches must use ILIKE.
- Wrap structural column/table identifiers in double quotes ("column"). Never use MySQL backticks.
- When performing structural rankings inside partitions (e.g. top item per group), you must use a CTE with a ROW_NUMBER() window function and filter WHERE rank_idx = 1 in the outer query.
- Never use generalized column headers or metric shortcuts not listed in the schema profile above.`;

    // Dynamic Few-Shot Architecture Insertion
    if (matchedTemplates.length > 0) {
      systemPrompt += `\n\n### BLUEPRINT SYNTAX Blueprints:\n` + 
        matchedTemplates.map(t => `- For ${t.description}:\n  ${t.sql_template}`).join("\n");
    }

    // Dynamic Local Historical Memory Insertion
    if (structuralSavedMemory.length > 0) {
      systemPrompt += `\n\n### USER HISTORICAL SUCCESSFUL EXAMPLES (Match formatting):\n` +
        structuralSavedMemory.slice(-2).map(m => `- Intent: ${m.userQuery}\n  Valid SQL: ${m.successfulSql}`).join("\n");
    }

    return systemPrompt;
  }

}

