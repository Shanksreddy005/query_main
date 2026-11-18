# Release Verification Evidence

Complete verification record for release v1.0 (source commit `8e6483f`), in chronological order. All reports were produced against the real application and real provider endpoints; no result in these documents was simulated.

| File | Contents |
|---|---|
| [full-audit-report.md](full-audit-report.md) | Full audit: pipeline blockers, dead-code findings, de-genericization plan — the origin of the remediation contract. |
| [final-release-verification-report.md](final-release-verification-report.md) | Final release verification: 30-question benchmark, 24 browser edge cases, privacy/network audit, analytical & chart verification, security & reliability runtime evidence. CONDITIONALLY APPROVED pending a real-provider test and version control. |
| [final-production-approval-report.md](final-production-approval-report.md) | Final production approval (Parts A/B/C): real Gemini + Groq integration across all 10 question categories, Git release reproducibility from a clean clone, remaining limitations. **APPROVED FOR PUBLICATION.** |
| [post-rotation-smoke-test-report.md](post-rotation-smoke-test-report.md) | Post-credential-rotation deployment smoke test: 12 checks against the deployed release — 12/12 PASS. |
| [r2-wasm-remediation-report.md](r2-wasm-remediation-report.md) | Cloudflare Pages 25 MiB remediation: DuckDB-WASM binaries moved to first-party R2 (`assets.querymind.in`); loading path traced, cross-origin browser verification, artifact integrity. Local verification complete; live R2/domain test pending operator setup. |
| [production-quality-remediation-report.md](production-quality-remediation-report.md) | Production quality remediation of the three defects found in the live audit of `https://querymind.in`: standalone SVG chart export, the optional ranking-direction validation gap plus full keyless coverage of the shipped E-Commerce questions, and the edge-injected analytics beacon. Root causes, files changed, 29 new regression tests, live browser evidence, artifact hashes, and the operator-side Cloudflare steps still outstanding. |
| [release-sign-off.md](release-sign-off.md) | One-page sign-off: release identity, build hashes, test evidence, decision chain and sign-off date. |

Note: literal Tailwind utility-class names mentioned in the original audit findings were replaced with plain descriptions here — the repository root is scanned for utility-class candidates during build (see [../DEPLOYMENT.md](../DEPLOYMENT.md)), and including such tokens verbatim would alter the production stylesheet.

Ground rules honoured throughout: LLM = semantic planner; deterministic code = analytical contract; DuckDB-WASM = local execution; verified execution results = source of truth. No dataset rows or complete query results were sent to any provider; no unverified result was ever returned as verified.
