# QueryMind Full Audit Report

> Preserved from the pre-remediation audit session. Findings below were used to define the remediation contract; each blocker/major listed here was subsequently fixed and covered by a regression test in `tests/`.

## Part 1 — Pipeline Verdict: Not publish-ready yet (1 blocker + 3 majors)

The architecture itself is genuinely strong — plan → validate → execute → re-validate, bounded self-correction, in-memory telemetry, BYOK in headers. But these must be fixed first:

**🔴 BLOCKER — Baked-in sample numbers ship as "verified" answers.**
`getDeterministicCuratedQuery` in [aiService.ts](../../src/services/aiService.ts) fires on *any* dataset with an `mrr` column, but hardcodes the sample-data narrative: "25 distinct customers", "$158,400", "Ironclad Security leads with $11,200". A user uploading a 4,000-row CSV asking "how many customers?" gets correct SQL but a wrong insight certified `status: 'verified'`. In a product whose pitch is accuracy, this is a silent-wrong-answer bug.
**Fix:** gate SAAS/ecommerce curated insights to known fixture ids only, or generate the narrative from actual DuckDB results.

**🟠 Curated path bypasses the entire validation architecture** — returns immediately with asserted (not earned) `passedChecks`; loose substring triggers (a question merely containing "top" matches "laptop"; concatenating "under" with a digit matches any question containing that digit). On a schema missing a referenced column, a "verified" query blows up later with a raw DuckDB error. **Fix:** run curated SQL through validated execution before returning.

**🟠 Blueprint fallback after 5 failed rounds skips validation** and returns unverified results with a generic insight, silently.

**🟠 Privacy claim vs. reality** — "100% browser-native", yet index.html loaded Google Fonts and DuckDB WASM bundles came from jsDelivr at runtime (leaks IP/referrer). **Fix:** self-host both (both are now self-hosted under `public/duckdb/` and `public/fonts/`).

Minors: malformed Gemini JSON threw raw `JSON.parse` errors at users; empty-result answers wasted up to 4 correction rounds; worst case 15 HTTP calls/query (now paced); plaintext key in localStorage deserves a warning label.

## Part 2 — Broken/dead code limiting capabilities

| Severity | Finding |
|---|---|
| 🔴 Critical | `AiQueryMindService` was never instantiated — the golden-template RAG (`config/genericPatterns.ts`) and saved-query memory never reached the live LLM prompt. Dead feature (now wired). |
| 🟡 Medium | `cancelCurrentQuery` exported but never wired — users couldn't stop a runaway query (now wired). |
| 🟡 Medium | Privacy auditor's `verifyPayloadDataLeakage` never called — "0 Rows Egress Verified" in the telemetry modal was static text, not a real check (now a real check). |
| 🟡 Medium | `visualizationSelector.ts` rule-ordering bug: generic top-N rule fired before the `top_n_per_group` branch, so "top product per region" charts lost the item entity (fixed). |
| 🟡 Medium | sqlEngine registered only one table (no joins), failed silently on registration error, and the cache key ignored content changes → stale data (fixed). |
| 🟡 Medium | `validators.ts` hardcoded test-suite scenarios in production code → false "clarification needed" blocks on real datasets (removed). |
| 🟡 Medium | sqlBlueprints fallback: ranking branch swallowed `aggregate_by_dimension` plans with limits; `percentage_of_total` blueprint unreachable (fixed). |
| ⚪ Low | Dead code: `SchemaProfiler` class, `hasPerGroupRankingLanguage`, `SQL_BLUEPRINTS`, unused CSS classes, `ExecutionOutput` declared twice, `localQueryStorage` unguarded `JSON.parse` (cleaned). |

## Part 3 — De-genericizing: making it look professionally designed

**Top 5 highest-impact visual changes (all applied):**
1. Unify the brand split (violet favicon/logo versus cold blue-gray body versus the warm charcoal/amber in-app system) to a single consistent palette.
2. Replace emoji section headers in ExecutiveBriefing with proper icon components.
3. Consolidate badge chaos into one badge style; reserve ALL-CAPS for micro section labels.
4. Tokenize hardcoded colors (raw amber/rose utility values and rgba gradients in Sidebar/Header/ResultsView) so they flow through theme tokens.
5. Delete dead weight (never-imported components, unused CSS/imports).

**Also done:** removed unused font load, added `theme-color`/OG meta, replaced native `alert()` with the styled error banner, replaced self-certified compliance claims with factual statements, a11y fixes (sortable headers, `aria-pressed`, dialog roles, focus handling).

## Outcome

Every finding in Parts 1–2 was fixed under the remediation contract (Phases 0–8), each with a regression test. The final release state is documented in [final-release-verification-report.md](final-release-verification-report.md) and [final-production-approval-report.md](final-production-approval-report.md).
