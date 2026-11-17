# QueryMind — Final Production Approval Report

## Decision: APPROVED FOR PUBLICATION

Real provider integration is demonstrated on real endpoints through the app, and the verified source state is committed and reproduces byte-for-byte from a clean clone. Two scope notes are recorded under *Remaining limitations*: Gemini was last queried end-to-end on the preceding commit (its free-tier quota hit a bounded 429 on the final commit), and every final-commit live run used Groq.

---

## Part A — Real provider integration

### Provider availability findings (measured, not assumed)

| Model | Result |
|---|---|
| `gemini-3.8-flash` (default) | HTTP 503 UNAVAILABLE, 3 bounded attempts then a clear notice |
| `gemini-3.7-flash` | HTTP 503 |
| `gemini-2.5-flash` | HTTP 404 |
| `gemini-3.6-flash` | Works; planning latency 5–70 s |
| Groq `openai/gpt-oss-120b` | Works; 2.5–5 s per plan |

### Gemini 3.6 Flash — 12 questions, all 10 categories

Executed through the production preview bundle at commit `aaf9a59` (the commit immediately preceding the formatting fixes), 30-row `querymind_sample_saas` fixture.

| # | Question | Result |
|---|---|---|
| 1 | How many customers do we have and what is the total MRR? | 30 / $23,200 — correct (20.7 s) |
| 2 | How many active customers in the Enterprise or Mid-Market segments have more than 3 support tickets and usage above 80%, and what is their combined MRR? | 7 / $11,700 — correct (42.5 s) |
| 3 | Who are the top 5 customers by MRR? | 5 correct rows from real SQL (45.7 s, 70.3 s) |
| 4 | Show total MRR and number of customers by segment | Correct; 60.3% / 23.3% shares (25.9 s) |
| 5 | What are the top 2 customers by MRR in each city? | Correct `ROW_NUMBER()` SQL; alias prose defect found (24.7 s) |
| 6 | What percentage of total MRR comes from each plan? | 60.34 / 18.32 / 15.52 / 5.82 — correct (36.1 s) |
| 7 | Show the number of new signups and their MRR by signup month | All 9 months correct (34.1 s) |
| 8 | Break down total MRR and customer count by segment and subscription status | 8 rows correct; "filtered result" wording defect found (33.1 s) |
| 9 | Give me an executive summary of our customer base | Correct; subset-share sentence defect found (33.1 s / 58.5 s) |
| 10 | What is the average NPS score by segment? | Correct refusal, 0 provider calls |
| 11 | Show total MRR by industry | Correct refusal with available-column suggestions |
| — | 3.8 / 3.7 503 behaviour | Retried 3× then a clear "busy or rate limited" notice; no hang |

For Q3 the provider legitimately took 70.3 s, which exceeded the old 45 s deadline; the deadline was raised to 90 s and re-verified.

### Groq `openai/gpt-oss-120b` — final commit `8e6483f`

| # | Question | Result |
|---|---|---|
| 1 | How many customers do we have and what is the total MRR? | 30 / $23,200, 4/4 validation checks; 1 call, 200, 3.8 s |
| 5 | What are the top 2 customers by MRR in each city? | 10 rows exactly correct; readable "top customer records within each city… ranked by total MRR"; 2 plans (first replaced by repair), 3.2 / 2.8 s |
| 6 | What percentage of total MRR comes from each plan? | CTE SQL returned $14,000 / $4,250 / $3,600 / $1,350 and 60.34/18.32/15.52/5.82%; no "no revenue measure" claim; 1 call, 3.3 s |
| 7 | Show the number of new signups and their MRR by signup month | 9 months match ground truth exactly; 1 call, 2.5 s |
| 8 | Break down total MRR and customer count by segment and subscription status | 8 rows correct; 53.9% share of $23,200; unfiltered limitation wording; 1 call, 3.2 s |
| 9 | Give me an executive summary of our customer base | 30 / $23,200 / 71.7% / 3; 1 call, 5.0 s |

Every run showed "QUERY MATCHES REQUEST (n CHECKS PASSED)", executed in local DuckDB-WASM, and the result table matched the narrative. No run fell back to a curated answer.

### Privacy evidence from the real traffic

For all recorded calls (Gemini and Groq, both commits): request bodies contained 0 fixture row values, no key appeared in any URL or body, keys were absent from `localStorage`/`sessionStorage`, and only same-origin assets plus the selected provider endpoint were contacted. Every fixture-question body was ~10 KB of schema metadata.

### Error handling exercised live

- Gemini 503/429 → 3 bounded attempts, then an actionable notice naming the status and suggesting a wait or model switch.
- Groq 429 (TPM 8000) → two plans succeeded, three retries hit 429, query stopped with a bounded notice; the identical question succeeded after the window reset.
- 401/malformed/non-JSON/timeout/cancel paths remain covered by [provider_transport.test.ts](../../tests/provider_transport.test.ts).

---

## Defects fixed (each with a regression test)

| Defect found by real runs | Fix | Location |
|---|---|---|
| 45 s deadline aborted healthy 60–70 s Gemini plans | Deadline raised to 90 s | [aiService.ts](../../src/services/aiService.ts) |
| Chart labelled a bar share "% of total" when groups were collapsed/shown subset | "% of the N values shown" | [DataChart.tsx](../../src/components/DataChart.tsx) |
| Per-group ranking prose used raw aliases | Item/group/metric nouns | [summaryEngine.ts](../../src/services/summaryEngine.ts) |
| Unfiltered breakdown called its shares "filtered result" | Where/limit-aware wording | [summaryEngine.ts](../../src/services/summaryEngine.ts) |
| KPI row claimed a subset share that was arithmetically wrong | Share sentences validated 0 ≤ part ≤ total, skipping avg/rate columns | [summaryEngine.ts](../../src/services/summaryEngine.ts) |
| Caveat denied a lifecycle column the dataset actually has | Checks dataset columns before claiming absence | [summaryEngine.ts](../../src/services/summaryEngine.ts) |
| `SUM(mrr_usd) AS plan_total` printed `14,000` and "no revenue measure" | Currency mapped through every SELECT projection, including CTEs | [summaryEngine.ts](../../src/services/summaryEngine.ts) |

The last fix required parsing all `SELECT` projections (CTEs hide the aggregate behind `plan_total`). The final bug was that the money-column extractor matched the function name `SUM` first; it now scans every identifier and excludes `COUNT(mrr_usd)` and arithmetic ratios.

---

## Part B — Git and reproducibility

- Branch: `main`
- HEAD: `8e6483ff66dc4962dd2748666af6518c3f09bedb`
- History: `942d6d3` → `aaf9a59` → `8e6483f`; working tree clean
- `.gitignore` excludes env files, keys/certs, `node_modules`, `dist`/`build`, local datasets (`*.csv`, `*.duckdb`, …), verification dirs and logs; `.gitattributes` pins LF so clones build identically
- No credential file, key or dataset is tracked; commits contain source and tests only

Clean-clone verification at `8e6483f` (`git clone` → `npm ci`):

| Check | Result |
|---|---|
| `npx tsc --noEmit` | passed, no output |
| `npm test` | **301 tests, 83 suites, 301 pass, 0 fail** |
| `npm run build` | passed (`index-sn9S7bCm.js`, 760.46 kB) |
| `dist` SHA-256 vs working tree | **all 10 files byte-identical** |

---

## Part C — Remaining limitations

1. **Gemini on the exact final commit.** The final-commit Gemini question was attempted and stopped correctly at a free-tier 429 (3 bounded attempts). Gemini's 12-question end-to-end run was on `aaf9a59`; the two Gemini-found defects were re-verified live on Groq at `8e6483f` and are unit-tested. Subsequently, the post-rotation smoke test ([post-rotation-smoke-test-report.md](post-rotation-smoke-test-report.md)) ran Gemini on the exact final build.
2. **Default Gemini model.** `gemini-3.8-flash` returned 503 during this key's testing; 3.6 Flash is the model that worked. This is a provider-side availability issue, not an app defect.
3. **Groq free-tier TPM (8,000).** Long planning prompts can exhaust the per-minute budget mid-query; the app stops after 3 attempts with a clear message and succeeds after the window resets.
4. **Provider latency** ranges 2.5–70 s; the 90 s deadline covers observed healthy calls without letting a hung socket run past two minutes.
5. **Aggregate metadata egress.** For tables of ≥10 rows the planner receives distinct counts and numeric min/max (documented in the UI and schema prompt); no rows or cell pairings are transmitted.
6. **Plan variability.** Providers choose different valid SQL for the same question; correctness is enforced by the deterministic validation contract and DuckDB results, not by plan identity.

## Key hygiene note

The Gemini and Groq keys used for this verification were shared in chat and have been **rotated**; the post-rotation smoke test confirmed no old credential remains in source, storage, logs or Git history. No key was ever written to source, storage, logs or the repository.
