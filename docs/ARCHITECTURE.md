# QueryMind — Architecture

QueryMind is a browser-native natural-language analytics engine: upload a CSV, ask a question in plain English, and receive SQL, a verified DuckDB result, a chart and an evidence-grounded summary — with no backend of QueryMind's own. Dataset rows and query results stay in the browser; on the provider path the application sends the question plus structural column metadata, and [PRIVACY.md](PRIVACY.md) states exactly which parts of that boundary are verified by tests, by live provider audits, and by the 2026-11-19 live keyless measurement.

## Core principle

The LLM is a **semantic planner only**. It never executes anything and is never trusted with your data or with the truth of an answer:

1. **Scope guard** — out-of-scope or unsupported requests (e.g. metrics the dataset cannot define, such as NPS) are refused before any provider call is made.
2. **Deterministic blueprint** — a known plan shape can be answered by a local SQL blueprint with no provider at all.
3. **LLM plan** — the provider (Google Gemini, Groq or OpenAI, user-supplied key) receives schema metadata — column names, types, roles, and for tables of ≥10 rows aggregate metadata (distinct counts, numeric min/max) — never rows, never results.
4. **Deterministic validation contract** — the returned SQL must pass named checks (read-only safety, target table verified, grouping/ordering/limit verified against the request, row-count and integrity checks) before it is allowed to execute. Invalid plans trigger bounded self-correction (repair rounds) rather than guesswork.
5. **DuckDB-WASM execution** — the validated SQL runs locally, in-memory.
6. **Re-validation and evidence-grounded summary** — every number, share and ranking sentence in the executive summary is computed from the executed result set; formatting (currency, percentages) is derived from the SQL projections, not from provider prose.
7. **Deterministic visualization** — the chart type is chosen by rules from the result shape, and chart labels state "share of the values shown" when the result is a subset. Chart Studio opens automatically only for results with more than one row and offers no chart toggle for a single-row result — one point is not a series; those values appear in the answer band when they fit within four columns, otherwise in the data table.

## Key guarantees

- **Verified labels are earned**: a result is only marked **Verified** when the deterministic contract has actually passed on the executed SQL. The badge's tooltip reads "Executed SQL answers this request · N integrity checks passed" (or "Executed SQL answers this request" when no check list is attached), and the same check count appears separately in the answer band's facts row.
- **Fallback answers are labelled**: if no provider plan passes validation after bounded rounds, a blueprint fallback is shown explicitly as "Blueprint SQL · no provider reply passed validation" — never as an AI answer.
- **BYOK**: API keys are entered in the Settings panel and held in tab memory by default; the optional "Remember API key" checkbox is opt-in. Keys are sent only as headers to the selected provider endpoint.
- **First-party asset hosts**: fonts and the DuckDB-WASM worker scripts ship from the app itself (`public/fonts/`, `public/duckdb/`); the two oversized `.wasm` binaries are served from the operator's own Cloudflare R2 custom domain `assets.querymind.in`, because they exceed the Pages per-file limit. No URL in the built application points at a third-party or public CDN asset host. On the deployed v1.2 build, the page frame's cold load requested only the Pages origin (HTML, JS, CSS and two fonts, plus one same-origin `blob:` entry); the engine binaries are fetched by the DuckDB worker from the R2 domain, which is what the live content-type, CORS and byte-count checks plus successful local execution establish. One qualification, recorded in full in [verification/v1.2-live-production-verification.md](verification/v1.2-live-production-verification.md): the hosting edge can inject its own analytics script into the served HTML, and one capture in that pass showed it happening, so "the application contacts no third-party asset host" is a statement about QueryMind's code and artifacts, not a guarantee about every byte a visitor's browser receives from `querymind.in`.
- **Provider dispatch is auditable**: the built-in Telemetry Auditor records every LLM request the app dispatches (URL, body size, status) without recording credentials, and can be inspected live from the UI. It is a provider-payload audit, not a full network monitor — engine and asset fetches are outside its scope, and it shows an empty record while the app is running keyless.

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
