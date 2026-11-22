# QueryMind — Production Quality Remediation Report

**Date:** 2026-11-18 · **Scope:** the three defects found in the live audit of `https://querymind.in`
**Source repository:** `query_main`, branch `main`, baseline commit `fc65e4b6ff9edec941130a32c45451afc0864871`
**Build verified in this report:** `dist/assets/index-BWBgMqJ9.js` (see artifact table)
**Deployment status:** not yet deployed. No production claim in this report is based on a simulation, and live re-verification of `https://querymind.in` is listed as a follow-up action, not as completed work.

Standing architecture, unchanged by this release: the LLM is only a semantic planner; deterministic code owns the analytical contract and validation; DuckDB-WASM executes locally in the browser; verified execution results are the source of truth.

---

## 1. Defect — "Download Chart as SVG" exported a toolbar icon

**Symptom in production.** The saved `.svg` file contained a 24×24 glyph instead of the chart.

**Root cause.** [src/components/DataChart.tsx:149-158](../../src/components/DataChart.tsx) previously serialized the chart panel with `chartContainerRef.current?.querySelector('svg')` and `XMLSerializer`. The panel markup holds its toolbar before the plot, and the first `<svg>` in document order is a Lucide icon, so the export captured an icon. Even when the correct node was found, the markup depended on Tailwind classes and `currentColor`, so the file was not viewable outside the application stylesheet.

**Fix.** The export no longer reads the DOM. A new pure builder, [src/services/chartSvgExport.ts](../../src/services/chartSvgExport.ts), generates a standalone SVG document from the same `chartData` array the on-screen view renders:

| Export concern | How it is handled |
|---|---|
| Chart types | `horizontal_bar`, `bar` (column), `line`, `area`, `donut` |
| Self-containment | `<?xml …?>` declaration, `xmlns`, explicit `width`/`height`/`viewBox` (880×520), `<title>` and `<desc>` |
| Style resolution | every fill/stroke is a literal hex from the light or dark export theme; no `class`, `style`, `currentColor` or `var(--…)` is emitted |
| Labels and values | category labels, value labels, legend rows, axis titles, subtitle with data-point count, aggregation method and "aggregated" flag |
| Geometry parity | reuses the UI clamps (bar width 3–100, column height ≥ 6, donut arcs via `stroke-dasharray` with a −90° rotation) and the shared `formatChartValue` formatter, so exported numbers equal on-screen numbers |
| Input safety | non-finite values become `0`, missing labels become `''`, an empty palette falls back to the theme accent — no throws, no injection of raw text into attributes |

`handleDownloadSvg` now chooses the theme from `isDarkMode`, requests the document, and saves it as `querymind_chart_<timestamp>.svg` through a Blob + temporary anchor. The dead `chartContainerRef` and unused `useId` were removed; the only surviving format helper is `formatVal`, which delegates to `formatChartValue` so on-screen and exported formatting cannot drift.

**Regression tests.** [tests/chart_svg_export.test.ts](../../tests/chart_svg_export.test.ts) — 14 tests:

- XML well-formedness via a tag-stack parser (void-aware) on every chart type.
- Per-type geometry: horizontal bar and column rects sized against the max value; line = 1 polyline path, area = 2 paths (the area path carries `fill-opacity="0.2"`); donut = one arc circle per datum with `stroke-dasharray`, plus a total centre label.
- Icon-regression guards, which is the direct anti-repeat of the reported bug: payload > 1000 bytes, no `lucide` substring, no `viewBox="0 0 24 24"`, and no `<svg>` element other than the root document.
- Theme contract: light and dark palettes are explicit hexes; both are asserted to contain no `currentColor`, `class=`, `var(--` or `<style>`.
- `formatChartValue` boundaries (millions, thousands, integers, decimals, non-finite).
- A filesystem round-trip: write the document to a temp file, read it back, compare byte-for-byte and confirm the parsed root dimensions.

**Live browser verification (production-mode bundle, real downloads).** The download was intercepted at the API level (`URL.createObjectURL` hook plus a capture-phase anchor-click listener) and the Blob text was read back — no reliance on the filename alone.

| Chart type | Bytes | Root dimensions | Notable assertion |
|---|---|---|---|
| horizontal bar | 5873 | 880×520 | 5 value labels match the results table |
| bar / column | 5576 | 880×520 | 5 `<path>` rects + baseline |
| donut | 4526 | 880×520 | 11 circles, 5 `stroke-dasharray` arcs, Total centre |
| line | 4452 | 880×520 | 1 path |
| area | 4616 | 880×520 | 2 paths, `fill-opacity="0.2"` |

Both themes were exported (light asserted as `#FDFCFB` / `#1C1917` / `#D97706` with no dark token leaking). The saved file was opened as a standalone document and rendered at 880×520 with 18 root children, i.e. it is viewable without the application CSS. Axis/aggregation choices in the chart customizer were confirmed to propagate into the export (subtitle "4 data points · Avg Discount Pct vs Region", values 20 / 12.5 / 6.7 / 4, identical to the table). Verification used the demo dataset and an uploaded CSV.

---

## 2. Defect — four of five E-Commerce demo questions demanded an API key

**Symptom in production.** Only 1 of the 5 shipped E-Commerce suggestions answered keyless; the others ended in a provider-key error, which contradicted the onboarding copy.

**Root cause A — validator disagreement over an optional field.**
[src/services/validators.ts:781](../../src/services/validators.ts) compared `plan.ranking_direction !== firstOrderDirection`. `ranking_direction` is optional on a `QueryPlan`, while both `constructSqlFromPlan` ([src/services/sqlBlueprints.ts:191](../../src/services/sqlBlueprints.ts), `plan.ranking_direction ?? 'DESC'`) and `parseQueryPlan` ([src/services/queryPlan.ts:109](../../src/services/queryPlan.ts)) resolve an omitted direction to `DESC`. A curated plan that omitted the field therefore emitted `ORDER BY … DESC` and was then rejected by its own validator with "requires undefined order". The failing intent check escalated the question to the LLM path, and with no key configured the user saw the API-key error — the reported defect was the visible tail of a validation bug.

**Fix A.** The check now reads the same default the builders use:

```ts
const planDirection = plan.ranking_direction ?? 'DESC';
if (isRanking && planDirection !== firstOrderDirection) { … }
```

Explicit `ASC` and `DESC` in a plan are still enforced, the error message can no longer print `undefined`, and no other intent check was weakened. Note the direction check runs only when a `question` is supplied (it is nested inside the `if (question)` guard), so the new tests pass a question deliberately — without one the assertions would pass vacuously.

**Root cause B — curated coverage.** The E-Commerce suggestion list ships five questions, but only one had a deterministic blueprint, so the remaining four had no keyless path at all.

**Fix B.** [src/services/aiService.ts:850-1110](../../src/services/aiService.ts) inside the E-Commerce column-shape guard: the existing top-category plan now states `ranking_direction: 'DESC'` explicitly, and three blueprints were added.

| Shipped question | Keyless path | Plan intent | Rows on the 15-row sample |
|---|---|---|---|
| "What are the top 5 most profitable products in Technology?" | existing blueprint, direction made explicit | `ranking` | 5 |
| "Show total sales, total profit, and average discount by region" | existing blueprint | `aggregate_by_dimension` | 4 |
| "Which products have negative profit margin due to high discounts?" | new: `GROUP BY product, category HAVING SUM(profit) < 0 ORDER BY total_profit ASC` | `aggregate_by_dimension` | 2 |
| "Compare category performance: sum of sales and profit sorted by profit desc" | new: `GROUP BY category ORDER BY total_profit DESC` | `aggregate_by_dimension` | 3 |
| "Show all orders with discounts greater than 15% and negative profit" | new: `WHERE discount_pct > 0.15 AND profit < 0 ORDER BY profit ASC` | `filter_lookup` with declared `filters` | 2 |

Triggers are deliberately narrow (the product-level audit requires "product" and forbids "order"; the record-level audit requires "order", "profit", "negative" and an explicit threshold) so the blueprints cannot take precedence over each other or hijack unrelated phrasing. The record-level audit reads its threshold as a percent and refuses to fire when the parsed number is not a positive integer: the normalizer strips punctuation, so "above 0.15" would otherwise read as `0` and produce a silently wrong `discount_pct > 0`. That case is left to the provider path rather than answered incorrectly. Every blueprint still runs through the full contract: `profileDatasetSchema` → `validateSqlIntent` → local DuckDB execution → `validateExecutionResult`.

**Regression tests.** [tests/curated_keyless_queries.test.ts](../../tests/curated_keyless_queries.test.ts) — 15 tests in two suites. The direction suite asserts: omitted direction + `DESC` SQL is valid; omitted direction + `ASC` SQL is rejected with `requires DESC order` and never the word `undefined`; explicit `ASC` and explicit `DESC` are both preserved; and `constructSqlFromPlan` and the validator agree on the default. It uses literal `QueryPlan` objects because `parseQueryPlan` normalizes the field and would hide the bug. The keyless suite asserts, for each shipped suggestion: a curated match exists, the engine label is `QueryMind Verified Blueprint Engine`, `validateSqlIntent` returns valid, and the emitted SQL has the expected shape; plus the threshold-parsing rule (fractional phrasing → no curated match), the non-hijack cases, and a SaaS tolerance test that only accepts an invalid curated plan when `checkMetricAvailability` also reports the metric as unavailable.

**Live browser verification.** All five suggestions were run keyless on the production-mode bundle: each displayed "QUERY MATCHES REQUEST (7–8 CHECKS PASSED)" and "In-Memory DuckDB" with 5 / 4 / 2 / 3 / 2 rows (41 ms for the threshold audit) and no key prompt. The SaaS "lost MRR" suggestion returns an honest clarification asking which metric to use — that is the pre-existing clarification contract, not a key demand, so the corrected copy below remains true.

**Promise review — keyless wording.** Both claims were re-worded to match the implementation rather than broadened; the deterministic path covers the shipped suggestions, not arbitrary questions.

| File | Before | After |
|---|---|---|
| [src/components/ApiKeyModal.tsx:427](../../src/components/ApiKeyModal.tsx) | "Key optional: Prebuilt datasets support instant verified queries" | "Key optional: the suggested demo questions run verified queries locally; custom questions need a key." |
| [src/components/OnboardingModal.tsx:385](../../src/components/OnboardingModal.tsx) | "Key optional for demo: preloaded datasets support verified queries keyless." | "Key optional for demo: the suggested questions on preloaded datasets run verified queries locally. Custom questions, uploads and free-text follow-ups need a provider key." |

---

## 3. Defect — Cloudflare edge-injected analytics beacon

**Finding.** The app never contacts a third party for analytics: the audit recorded only same-origin requests (JS, CSS, self-hosted Inter and JetBrains Mono fonts, the DuckDB worker blob) plus the first-party R2 fetch for the WASM binaries. The beacon came from the Cloudflare Pages edge, which rewrites the HTML and injects Web Analytics / RUM — `static.cloudflareinsights.com/beacon.min.js`, `__cfBeacon` / `RumSDK.ArmsRum`, `__ARMS_RUM_INJECTED__`, and a `POST /cdn-cgi/rum`. That contradicted the in-product privacy copy, so the decision is to disable the feature at the edge rather than soften the copy.

**Deliberate scoping.** Per instruction, no Cloudflare dashboard access or change was made by me, and nothing was deleted or reconfigured in the platform. The change is yours to perform; the exact steps are in section 6.

**Documentation policy.** `docs/SECURITY.md` and [src/components/TelemetryAuditorModal.tsx](../../src/components/TelemetryAuditorModal.tsx) are **intentionally unchanged in this release**. Both are updated only after the setting is disabled and live network behaviour is re-measured, and they will describe what was observed: no absolute "zero third-party network" claim is made unless the measurement supports it. The current auditor sentence about self-hosted assets is still pending that reconciliation.

**No measurement is claimed here as evidence that the beacon is gone — it is not gone until the setting is turned off and re-verified.**

**Measurement update, 2026-11-19 (later pass, recorded elsewhere).** After the release was pushed and deployed, the live site was fetched and observed in a browser repeatedly. The result was not uniform, and is reported as measured. One capture showed the beacon: the served HTML carried a third-party script from `static.cloudflareinsights.com`, `window.__cfBeacon` was defined, and the page sent a same-origin `POST /cdn-cgi/rum`. The captures taken afterwards, with the browser cache bypassed, showed none of it: the served document was 1,790 bytes and byte-identical to `query_prod/index.html`, held exactly one script element (the app bundle), `window.__cfBeacon` was undefined, and six cache-bypassing refetches from inside the page all returned that same single-script document. `cloudflareinsights`, `beacon.min.js`, `__cfBeacon`, `cdn-cgi/rum` and `gtag` appear in no file of either repository. A `window.RumSDK` global with an `ArmsRum` key was present in the browser's page context throughout, including in the captures where no third-party script was loaded, and could not be attributed to QueryMind — no markup, no bundle string, no request. No Cloudflare dashboard was opened and no setting was changed, so this update establishes detection, not configuration: **the finding in this section stays open**, because a beacon was observed on the deployed site during the verification pass and nothing here explains why other captures were clean. Full wording and limits: [v1.2-live-production-verification.md](v1.2-live-production-verification.md), sections 2 and 3.

---

## 4. Release verification

| Step | Result |
|---|---|
| `npm ci` | passed from the committed lockfile |
| `npx tsc --noEmit` | clean, no errors |
| `npm test` | **330 / 330 pass**, 86 suites, 0 fail, 0 skipped (301 before this release; +14 SVG export, +15 curated keyless) |
| `npm run build` | passed, Vite 8.3.5, 1829 modules |

### Artifact hashes (new build)

| File | SHA-256 |
|---|---|
| `index.html` | `aff3b3a5ceb83951501dafec5e9df746158b5268f6dbd69a2fd0512fa5142945` |
| `assets/index-BWBgMqJ9.js` | `7eb989b5d82933dd5b60c147df80ca2c6280b25e10836a64206387e074ed20d3` |
| `assets/index-B5urW9Yt.css` (unchanged from the previous release) | `0578ef8eb7d42c66df4c20e7139d108060ae648a43ca9328a6f5e25ccf28db6f` |
| `assets/aistudio/image_ff69bad7.png` | `ff69bad7d2d91321292459a2b54392093e123d0575276a5ee8d7f69bc0cac6dc` |
| `duckdb/duckdb-browser-eh.worker.js` | `fa889e6068c40426dea67c08cf16ce0cad7404eae94f6a2522adcabb5898eb93` |
| `duckdb/duckdb-browser-mvp.worker.js` | `964f678d3bfa5a23deb154e0a7950634a4d1415e571040ab2d47815dc3f13582` |
| `fonts/inter-latin-variable.woff2` | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| `fonts/jetbrains-mono-latin-variable.woff2` | `83c005d49d8a6a50474c73a5a36ac0468076e9c4a29da7bdb14995d80560a5be` |
| R2 `duckdb/1.33.1-dev57.0/duckdb-eh.wasm` (unchanged) | `3abdec74989dcc54d2f2ea5621f611f3c45db1e7dff2f408476014d82beb2029` |
| R2 `duckdb/1.33.1-dev57.0/duckdb-mvp.wasm` (unchanged) | `ee5560145a3d3e0ffa6dce697be802c08842f139a594698eecc7c754f7ad5f05` |

Only `index.html` and the main JS changed. The CSS, both workers, both fonts, the image and **both R2 WASM objects are byte-identical to the previously verified release**, so no R2 re-upload is needed for this release.

**Build-determinism note (why the CSS is unchanged).** An intermediate build emitted three extra stylesheet rules — a full-width layout rule, a hidden-visibility rule and an outline/elevation rule — because Tailwind v4 scans prose for candidate class names, and the plain English words for those rules appeared in new code comments, test messages and in this report. [docs/DEPLOYMENT.md](../DEPLOYMENT.md) already records that constraint, and this document follows it by describing the rules instead of naming them. The wording was neutralized instead of the code, which returned the stylesheet to the previously verified bytes; the minified JS content hash was unaffected by the rewording (asserted identical across the pre- and post-reword production builds).

### Browser tests repeated against a production-mode bundle

| Test | Result |
|---|---|
| All five E-Commerce suggestions, keyless | verified — see section 2 |
| SVG export, all five chart types, both themes | verified — see section 1 |
| Standalone renderability of the saved file | verified — 880×520, 18 root children |
| CSV upload (4 rows → table `qm_upload_test`) then curated query | verified — 2 rows, 7 checks passed |
| CSV export | verified — `querymind_results_*.csv`, 100 bytes, `Tools,2,2800,420,15` / `Gadgets,2,2000,240,12` |
| JSON export | verified — 830 bytes, includes the question and the executed SQL |
| Telemetry Auditor modal | renders; wording deliberately not yet changed (section 3) |
| SaaS "lost MRR" suggestion | honest keyless clarification, as designed |

**Verification-environment note.** A production-mode build served from `localhost` cannot fetch the WASM from `assets.querymind.in`, because the R2 CORS policy allows only the `querymind.in` origins and the Pages placeholder. That is the intended production posture, not a defect. The browser tests therefore used the same production build with the WASM base overridden to a local absolute URL (`VITE_DUCKDB_WASM_BASE_URL`); the shipped bundle differs from that tested bundle only in that one URL constant, and the live post-deployment test in section 6 is what closes the loop on it. No other code path was substituted.

---

## 5. Security and privacy impact

- No security control was removed or relaxed. `validateSqlSafety` still runs on every execution path, `validateSqlIntent` and `validateExecutionResult` still gate the "verified" status, and the new default in the direction check only aligns the validator with the plan builders — it cannot make a wrong answer pass.
- Execution remains browser-local: DuckDB-WASM in a Web Worker, single active table, 15 s timeout, 5000-row cap, worker termination on timeout and cancel. Nothing moved server-side.
- The R2/WASM split-hosting architecture, `DUCKDB_WASM_VERSION` pinning and same-origin worker loading are unchanged.
- Chart export introduces no new network activity: it builds a string and saves it through a Blob URL. Exported text is escaped through the same attribute-safe path as before, with non-finite numbers coerced to `0`.
- No API key is stored, logged or embedded by this change; the keyless paths use no provider at all.
- Privacy-relevant behaviour that remains open is the Cloudflare edge beacon, addressed by section 6 rather than by code.

---

## 6. Remaining manual actions (yours — Cloudflare dashboard)

I did not open or change any Cloudflare setting. To remove the injected analytics beacon:

**A. Turn off Web Analytics for the site (do this first).**
1. Cloudflare dashboard → **Analytics & Logs → Web Analytics** (older label: *Apps Analytics*).
2. If a site tile exists for `querymind.in` (or the Pages preview hostname), open it → **Settings / Management → Site settings** → **Web Analytics measurement** → turn off, or choose **Remove site** if you never enabled it deliberately.
3. In the same Web Analytics area, check **Account Settings → Site Settings Apps** for an "Auto-Deploy" / "Automatically add new sites" toggle and disable it, otherwise a future Pages deployment re-enables injection.

**B. Turn off Real User Monitoring (RUM) / Browser Insights if present.**
1. **Analytics & Logs → RUM (Digital Experience Monitoring)** — if a QueryMind application entry exists, open it and disable *RUM* / stop the beacon snippet injection.
2. **Observability → Performance → Speed → Browser Insights** (or Zaraz/RUM widget area) — disable Browser Insights for the domain if it is on.

**C. Confirm nothing else injects scripts.**
1. **Zone `querymind.in` → Scans → Manage Custom Rules**: no rule should be adding a script; leave security rules untouched.
2. **Speed → Optimization → Content Optimization**: confirm no "RUM beacon" / analytics-injection feature is enabled.
3. **Zaraz (if enabled for the account)** → remove any Google Analytics / Cloudflare Insights tag on this zone.

**D. Purge and re-measure.**
1. **Caching → Purge Everything** for the zone (the injected markup is inside the served HTML).
2. Tell me the change is done. I will then re-fetch `https://querymind.in` and assert, from the live HTML and the network log, that no `cloudflareinsights.com`, `__cfBeacon`, `RumSDK.ArmsRum`, `__ARMS_RUM_INJECTED__` or `POST /cdn-cgi/rum` remains, and only after that evidence will `SECURITY.md` and the Telemetry Auditor copy be updated.

**Status after the v1.2 live pass.** The re-fetch and the marker assertions were performed on 2026-11-19, on the deployed release, without any dashboard change being reported or inspected — and step D therefore is **not complete**: no dashboard setting was confirmed. One capture of the deployed site still showed the full beacon chain (edge-injected `static.cloudflareinsights.com` script, `__cfBeacon`, same-origin `POST /cdn-cgi/rum`), while the cache-bypassing captures that followed served the repository artifact unchanged, with the app bundle as the page's only script and none of the listed markers present. `SECURITY.md`, `PRIVACY.md`, `ARCHITECTURE.md`, `DEPLOYMENT.md` and the deployment repository README have been reconciled to exactly that position: the application's artifacts carry no analytics code, and the deployment's beacon state is unmeasured because the dashboard was never opened. Two further notes carry into that wording. The auditor self-hosting sentence is application source and was deliberately not edited in a documentation-only pass. And the D.2 list treats `RumSDK.ArmsRum` as a beacon marker, whereas the live pass found a global of that shape in the browser's page context even where no third-party script was loaded at all — which is why the reconciled documents describe it as an unattributed observation rather than as either a beacon trace or a clean absence.

---

## 7. Open findings deliberately left out of this release

| Finding | Why it is not fixed here |
|---|---|
| The executive summary could mislabel the ranked metric ("5 orders were ranked by total sales … leads with $3,798" for a profit-ranked plan) | **Closed after this report was written.** The metric is now read from the executed query instead of inferred, with `tests/ranking_metric_label.test.ts` holding the fix; the row is kept as the finding that scoped that work |
| The icon-only Upload button has no accessible name below 640 px | a11y polish, no functional impact; out of the three-defect scope |
| Sidebar "Zero telemetry · In-memory DuckDB", the header "no app telemetry" tooltip and the auditor self-hosting sentence | must be reconciled with the live measurement in step D, not before. The live measurement happened on 2026-11-19 and the documentation was reconciled to it; these three sentences are `src/` code, so they stay unchanged until a source edit is separately approved. What they currently assert, and what the measurement supports, is recorded in [v1.2-live-production-verification.md](v1.2-live-production-verification.md) section 10 |

---

## 8. Approval state

Changes are committed **locally only** in `query_main` and `query_prod`. Nothing has been pushed. Pushing either repository, and deploying, awaits explicit approval.

**Superseded on 2026-11-19:** approval was given, both repositories were pushed (`query_main` → `a49532a`, `query_prod` → `7dcdb25`), Cloudflare Pages deployed the release, and the live verification of that deployment is recorded in [v1.2-live-production-verification.md](v1.2-live-production-verification.md).
