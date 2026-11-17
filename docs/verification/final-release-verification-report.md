# QueryMind: Final Release Verification Report

> Preserved from the release-verification session. The build identity in this report refers to the pre-release bundle (`index-DyRgSigU.js`, 289 tests) — the subsequent final commit `8e6483f` raised the suite to 301 tests and is covered by [final-production-approval-report.md](final-production-approval-report.md).

**Decision: CONDITIONALLY APPROVED.** Every P0 criterion was verified against the production build at runtime. Approval is conditional because the AI provider was simulated throughout: no real Gemini, Groq or OpenAI key was ever used.

**Build verified:** `dist/assets/index-DyRgSigU.js`. Type check is clean and 289 of 289 tests pass (up from 280 at the start of this pass).

## Phase results

| Phase | Result | How it was verified |
|---|---|---|
| 2. 30-question benchmark | Pass | Run through the real app and DuckDB; one ranking defect fixed earlier |
| 3. 24 edge cases | Pass | Full sweep on an earlier build; on the final build 9 key cases were re-run and all passed |
| 4. Privacy | Pass | Only same-origin resources load and only the app's own script runs. Prompts carry column names only, never rows or results. After switching datasets, no old table name or values were sent |
| 5. Analysis and charts | Pass, after 5 fixes | Every number checked against hand-computed totals from the CSV |
| 6. Security and reliability | Pass, after 3 fixes | Each check was exercised in the running app (below) |

## What was verified in Phase 6

- **Rejected API key (401):** exactly one request, no retry, and a clear message telling the user to fix the key in Settings.
- **Rate limit (429):** waited about 2.2 s, retried once, then returned correct results.
- **Server busy (503):** stopped after the 3-attempt limit, showed an honest error and no result.
- **45-second deadline:** a reply that never arrived timed out at 45 s with "nothing was executed" (the deadline was later raised to 90 s after real Gemini planning latency exceeded 45 s; see [final-production-approval-report.md](final-production-approval-report.md)).
- **Stop button:** no further requests were sent, no late result appeared, and the question stayed in the input box.
- **Failed SQL:** the agent stopped after its 5-round limit. The fallback answer is labelled "Blueprint SQL · no provider reply passed validation", so it is never passed off as the AI's answer.
- **Malicious SQL:** a `DROP TABLE`, a hidden `DELETE`, and a query on DuckDB's internal table list were all blocked; the table still had all rows afterwards.
- **Re-uploading changed data:** the same file with one value changed gave a different total, so stale cached data is not reused.
- **Switching datasets:** the new table and its name are used correctly.

## Defects fixed in this pass (each has a regression test)

1. **Time trends were described like segment comparisons.** One recommended action read "Prioritize 2025-03 retention", treating a month like a customer. Trends now get their own write-up: direction, peak and low months, the biggest monthly drop and rise, recent versus early averages, whether the drop came from fewer customers or lower revenue per customer, and a note that signup months are cohorts.
2. **Currency over $1,000 lost its trailing zero** ("$1,662.5"). Now "$1,662.50".
3. **A "percent of total" column was treated as a separate metric.** This repeated a share three times and produced a nonsense action. The summary now states it once, plus whatever share falls outside the result.
4. **The raw column name appeared in the summary text.** Display names are used instead.
5. **Gemini and Groq gave vague key errors.** They now say the key was rejected, including Gemini's HTTP 400 "invalid key" response.
6. **Memory leaks in DuckDB.** Each upload kept a full extra copy of the data, and switching datasets left the old table loaded. Verified against the real DuckDB engine; now only one table stays loaded and the temporary copy is deleted.
7. **Row counts overclaimed.** A count on a "sales" table said "3 distinct orders". It now says "distinct" only when the query actually counts distinct values, and a "sales" table no longer implies its rows are orders.

Main changes: [summaryEngine.ts](../../src/services/summaryEngine.ts), [aiService.ts](../../src/services/aiService.ts), [sqlEngine.ts](../../src/services/sqlEngine.ts); memory fix tested in [duckdb_memory_cleanup.test.ts](../../tests/duckdb_memory_cleanup.test.ts).

## Conditions for full approval (both subsequently met)

1. **Test with a real API key** — satisfied in [final-production-approval-report.md](final-production-approval-report.md).
2. **Put the project under version control** — satisfied by the Git release and clean-clone reproducibility in the same report.

## Known limitations (stated publicly, still true at v1.0)

- Only one table can be analysed at a time; joins across uploads aren't supported.
- Signup-month trends show the revenue each signup group brings in today, not revenue earned during that month.
- A few result shapes get no chart: a single numeric column, numbers with no category, or a number used as the category.
- The main JavaScript bundle is about 760 kB (about 206 kB compressed).
- Privacy is supported by observed network traffic and request contents, not by a claim of absolutely zero outgoing data.
