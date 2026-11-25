# QueryMind — Testing Guide

## Commands

```bash
npm ci            # clean install from package-lock.json
npx tsc --noEmit  # type check — must be silent
npm test          # full suite: tsx --test tests/*.test.ts
npm run build     # production build (must succeed with tests green)
```

**Verified working-tree status (2026-11-22):** 435 tests / 111 suites / 19 test files / 0 fail; type check clean; production build succeeds. The earlier v1.0 release sign-off recorded 301 tests / 83 suites on 2026-11-17 — a historical measurement preserved in [verification/release-sign-off.md](verification/release-sign-off.md).

**Public-site pass (2026-11-25):** 467 tests / 118 suites / 20 test files / 0 fail; type check clean; two consecutive production builds byte-identical. The landing, privacy and contact pages were deployed the same day (query_prod `aa0a7e6`). The working tree then replaced the public header's three-state theme cycle with two explicit light/dark buttons; the suite count is unchanged.

## Test inventory (`tests/`)

| File | Covers |
|---|---|
| `accuracy_architecture.test.ts` | End-to-end accuracy architecture: plan → validate → execute → re-validate. |
| `agentic_production_readiness.test.ts` | Production readiness of the agentic planning/repair loop. |
| `browser_gate_verification.test.ts` | Browser-side verification gates. |
| `browser_worker_cancellation_and_download.mjs` | Browser worker cancellation and CSV download (run manually with a browser; not part of `npm test`). |
| `deterministic_semantic_reference.test.ts` | Deterministic semantic reference tables and refusals. |
| `duckdb_memory_cleanup.test.ts` | DuckDB table lifecycle: no leaked copies, stale tables removed. |
| `evidence_visualization.test.ts` | Evidence-grounded summaries and chart selection. |
| `executive_summary.test.ts` | Executive-summary correctness (shares, trends, limitations wording). |
| `prod_browser_test.mjs` | Production build browser smoke test (manual). |
| `product_quality_regression.test.ts` | Product quality regressions. |
| `public_site.test.ts` | Public routes, landing copy, privacy/contact disclosure, metadata and public-site accessibility contracts. |
| `provider_transport.test.ts` | Provider transport: retry/backoff, 429/503/401 handling, timeout (90 s deadline), cancellation. |
| `release_candidate_security.test.ts` | Security regressions: SQL sandbox, egress sanitization, key handling. |
| `release_verification_fixes.test.ts` | Regression tests for every defect fixed during release verification (currency/alias mapping, per-group prose, share gating, lifecycle caveats). |
| `remediation_contract.test.ts` | The remediation contract phases (curated-answer elimination, unified validation contract, fallback labelling). |
| `seeding_integrity.test.ts` | Starter-template and fixture seeding integrity. |

## Regression policy

- Every bug fix must land with a regression test in `tests/`.
- Before any release: `npx tsc --noEmit && npm test && npm run build` must all pass.
- The build is content-addressed; a faithful rebuild of the same source tree reproduces identical bundle hashes (exception noted in [DEPLOYMENT.md](DEPLOYMENT.md#rebuild-reproducibility)).

## Provider keys in tests

Unit tests never call real provider endpoints. To exercise live providers, run the app in a browser with your own key entered in Settings (BYOK) — see [PRIVACY.md](PRIVACY.md) for what is transmitted. Never paste keys into test files, source, or logs; `.gitignore` excludes `.env*`, keys and certificates by design.
