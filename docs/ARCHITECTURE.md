# QueryMind — Architecture

QueryMind is a browser-native natural-language analytics engine: upload a CSV, ask a question in plain English, and receive SQL, a verified DuckDB result, a chart and an evidence-grounded summary — with no backend and no dataset ever leaving the machine.

## Core principle

The LLM is a **semantic planner only**. It never executes anything and is never trusted with your data or with the truth of an answer:

1. **Scope guard** — out-of-scope or unsupported requests (e.g. metrics the dataset cannot define, such as NPS) are refused before any provider call is made.
2. **Deterministic blueprint** — a known plan shape can be answered by a local SQL blueprint with no provider at all.
3. **LLM plan** — the provider (Google Gemini, Groq or OpenAI, user-supplied key) receives schema metadata — column names, types, roles, and for tables of ≥10 rows aggregate metadata (distinct counts, numeric min/max) — never rows, never results.
4. **Deterministic validation contract** — the returned SQL must pass named checks (read-only safety, target table verified, grouping/ordering/limit verified against the request, row-count and integrity checks) before it is allowed to execute. Invalid plans trigger bounded self-correction (repair rounds) rather than guesswork.
5. **DuckDB-WASM execution** — the validated SQL runs locally, in-memory.
6. **Re-validation and evidence-grounded summary** — every number, share and ranking sentence in the executive summary is computed from the executed result set; formatting (currency, percentages) is derived from the SQL projections, not from provider prose.
7. **Deterministic visualization** — the chart type is chosen by rules from the result shape, and chart labels state "share of the values shown" when the result is a subset.

## Key guarantees

- **Verified labels are earned**: a result is only marked "QUERY MATCHES REQUEST (n CHECKS PASSED)" when the deterministic contract has actually passed on the executed SQL.
- **Fallback answers are labelled**: if no provider plan passes validation after bounded rounds, a blueprint fallback is shown explicitly as "Blueprint SQL · no provider reply passed validation" — never as an AI answer.
- **BYOK**: API keys are entered in the Settings panel and held in tab memory by default; the optional "Remember API key" checkbox is opt-in. Keys are sent only as headers to the selected provider endpoint.
- **Self-hosted assets**: DuckDB-WASM bundles and fonts ship from the app itself (`public/duckdb/`, `public/fonts/`); no CDN is contacted at runtime.
- **Outbound telemetry is auditable**: the built-in Telemetry Auditor records every outbound request (URL, body size, status) without recording credentials, and can be inspected live from the UI.

## Module map (`src`)

| Module | Role |
|---|---|
| `App.tsx`, `main.tsx`, `index.css` | Application shell, routing of modals/state, global styles. |
| `components/QueryInputArea.tsx`, `ResultsView.tsx`, `DataChart.tsx`, `ExecutiveBriefing.tsx` | Question entry, result table/trace, charts, evidence-grounded executive summary. |
| `components/CsvUploader.tsx`, `Sidebar.tsx`, `Header.tsx`, `OnboardingModal.tsx`, `ApiKeyModal.tsx` | Dataset upload, dataset/query library, header controls, first-run setup, provider key configuration. |
| `components/OutOfScopeModal.tsx`, `TelemetryAuditorModal.tsx`, `StorageControlPanel.tsx`, `MinimalistMetricChart.tsx`, `QueryMindLogo.tsx` | Scope refusals, live outbound-request audit, storage panel, alternate chart renderer, brand mark. |
| `services/aiService.ts` | Provider transport (Gemini/Groq/OpenAI), prompt construction, bounded retry/self-correction, 90 s request deadline, scope guard. |
| `services/queryPlan.ts` | Typed plan representation parsed from the LLM reply. |
| `services/sqlBlueprints.ts` | Deterministic SQL blueprints and the no-provider fallback path. |
| `services/validators.ts` | The deterministic validation contract applied to every plan before execution. |
| `services/sqlEngine.ts` | DuckDB-WASM registration/execution, table lifecycle and cleanup. |
| `services/summaryEngine.ts` | Evidence-grounded narrative: metric formatting, shares, limitations, lifecycle caveats. |
| `services/visualizationSelector.ts` | Rule-based chart selection from result shape. |
| `services/schemaProfiler.ts` | Semantic schema profiling (dimensions/measures/temporal, PII-sensitive column detection) and prompt schema. |
| `services/sampleData.ts` | Bundled fixtures (SaaS customers, e-commerce sales), CSV parsing and schema inference. |
| `services/keyStorage.ts` | Opt-in remembered key storage and clearing. |
| `services/localQueryStorage.ts` | Saved-query library persistence. |
| `services/libraryShareEngine.ts` | Export/import payload for sharing a saved-query library. |
| `services/templateMatcher.ts`, `config/seedTemplates.ts`, `config/genericPatterns.ts` | Verified starter templates and golden-template matching. |
| `services/telemetryAuditor.ts` | Outbound request audit trail shown in the Telemetry Auditor modal. |
| `services/csvExportSanitizer.ts` | CSV/JSON export sanitization (formula-injection safe). |
| `services/modelRegistry.ts` | Available provider/model catalog with capability metadata. |

## Data flow example

For *"Show total MRR and number of customers by segment"* on the bundled SaaS fixture:

1. The planner maps `segment` (dimension) and `mrr_usd` (measure) and proposes `SELECT segment, ROUND(SUM(mrr_usd), 2) AS total_mrr, COUNT(DISTINCT customer_id) AS customer_count FROM dataset GROUP BY segment ORDER BY total_mrr DESC`.
2. The validation contract verifies read-only safety, target table, grouping, ordering direction, one row per segment and non-null integrity.
3. DuckDB-WASM returns 4 rows; the summary derives shares (Enterprise 60.3% of returned MRR, 23.3% of customers) from the executed columns and states the dataset-lifecycle caveat (no subscription-status column in the result).

## Further reading

- [SECURITY.md](SECURITY.md) — security architecture and SQL sandboxing.
- [PRIVACY.md](PRIVACY.md) — outbound data policy, prompt privacy, credential storage.
- [TESTING.md](TESTING.md) — the test suite and regression policy.
- [DEPLOYMENT.md](DEPLOYMENT.md) — building for production and hosting.
- [verification/](verification/) — release verification evidence.
