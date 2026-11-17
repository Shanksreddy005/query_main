## QueryMind — Post-Rotation Deployment Smoke Test

**Date:** 2026-11-17 · **Target:** commit `8e6483ff66dc4962dd2748666af6518c3f09bedb` · branch `main` · clean working tree · preview bundle `dist/assets/index-sn9S7bCm.js` (SHA-256 `8c03ef43ed796a1d09b8dc41f03a957aa81614d195cca5d5fe3d4d69826f41b5`) · 30-row `querymind_sample_saas.csv` fixture · real provider traffic (no simulation).

**Purpose:** after the previously exposed credentials were rotated, re-verify the deployed release end-to-end with the replacement keys. No baseline changes were made during this test.

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Replacement Gemini + Groq credentials verified via existing secure settings | **PASS** | Both keys verified inside Settings → provider password field → *Test Key*: Gemini `HTTP 200` (chip `GEMINI`), Groq `HTTP 200` on `/openai/v1/models` (chip `GROQ`). "Remember API key" left unchecked → tab-memory only. No key ever entered outside the app's Settings field. |
| 2 | Simple aggregate query | **PASS** | Groq and Gemini both: 30 customers / $23,200 total MRR; 4 named validation checks passed; matches ground truth. |
| 3 | Grouped aggregation | **PASS** | Both: Enterprise $14,000/7, Mid-Market $6,150/6, SMB $1,950/9, Startup $1,100/8 (Groq 7 checks, Gemini 7 checks). SQL: `GROUP BY segment ORDER BY total_mrr DESC`. |
| 4 | Top-N-per-group | **PASS** | Both returned the same 10 rows (2 per city) that matched an independent recompute from the raw CSV; ranking validated by the window-ranking partition check. |
| 5 | Signup-month trend | **PASS** | Both: 9 months 2025-01→2025-09 with MRR per month, identical to CSV recompute (2025-01 4/$3,150 … 2025-09 2/$2,000). |
| 6 | Unsupported metric (NPS) | **PASS** | Both providers: `CLARIFICATION NEEDED`, **0 provider calls issued**, trace "Metric \"NPS\" is not directly defined … no proxy measure will be substituted." No fabricated number reached the UI. |
| 7 | Every success passes the deterministic validation contract | **PASS** | Gemini grouped run's trace labels: Read-only statement safety (SELECT) · Target table references verified (querymind_sample_saas) · Group by segment verified · Ranking direction (DESC) verified · Exactly 1 row per unique segment verified · Non-null primary column data integrity verified · Complete DuckDB result verified. |
| 8 | UI displays the actual DuckDB result | **PASS** | Rendered tables compared against an independent JS recomputation from the CSV — top-2-per-city `identical:true, mismatches:[]`; trend `matchesIndependent:true`; KPI/summary values derived from executed columns, not prose. |
| 9 | No dataset rows or full results sent to provider | **PASS** | Egress audit over every recorded request body: `fullRowSignaturesInBodies: 0`, `resultRowPairingsInBodies: 0`. Only 2 dataset-shaped strings appear (`Enterprise`, `Active`), proven static prompt boilerplate because non-existent siblings (`Technology`, `Churned`) ship in the same literal. |
| 10 | Invalid credentials produce actionable errors | **PASS** | Bogus Gemini → `HTTP 400: Invalid or unauthorized Gemini API key (API key not valid…)`. Bogus Groq → `HTTP 401: Invalid Groq API key (invalid_api_key)`. Both messages name the remedy; the bogus secret value itself is never echoed. |
| 11 | No old credential in source, storage, logs or Git history | **PASS** | 0 matches for either credential across all 3 revisions (full history diff), all tracked files, ignored build artifacts, `dist/`, and browser localStorage/sessionStorage/IndexedDB/cookies re-scanned with both keys active. History contains only synthetic test placeholders (`AIzaSyFakeKey_AuditGate4_Verification_12345`, `sk-replacedVolatileKey222`). `.env.example` values empty. All console messages contain no key material. |
| 12 | Deployed commit + build identity recorded | **PASS** | `8e6483ff66dc4962dd2748666af6518c3f09bedb`, `main`, clean tree. JS `8c03ef43…41b5`, CSS `0578ef8e…8db6f`, `index.html` `e1f2af14…48ff7` — unchanged from the reproducibility run. |

**Non-blocking observations (no baseline changes made):**

- Free-tier throttling surfaced twice and was handled correctly by the existing contract: Gemini `429` after 3 attempts → "wait 30–60 s / switch model" notice; Groq `429` (TPM 8000) → retried successfully after ~75 s. One Gemini `503` on a model-selection probe also produced an actionable notice. These are quota events, not defects.
- Groq concatenates `(C0xx)` into the customer label while Gemini projects `customer_name`; values are identical, so this is a provider planning-style difference, not a correctness issue.

**Verdict: 12/12 PASS.** The release at `8e6483f` is deployment-healthy with the rotated credentials.
