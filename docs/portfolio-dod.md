# Portfolio definition of done

Local QEL-7 evaluation on **2026-11-22**, starting at `a18f6d6517235f5a89e8717f11ceb94165e51913`. The criteria below evaluate the portfolio and its evidence. Final hosted acceptance of the documentation revision is a separate condition.

| # | Criterion | Status | Evidence and verification | Outstanding condition |
| --- | --- | --- | --- | --- |
| 1 | Runnable controlled SUT | PASS | Executed the [quickstart](../README.md#quickstart) from a fresh clone. Compose reported a healthy SUT on the owned internal network. | None |
| 2 | Verified quality dimensions | PASS | Retrieved the [hosted native bundle](../evidence/README.md#hosted-baseline) and revalidated performance smoke, accessibility, keyboard, CSP, passive ZAP and dependency audit. | PERF-G02 eligibility remains `INCONCLUSIVE`. |
| 3 | Explicit mandatory gates | PASS | Cross-checked the [gate matrix](../README.md#quality-gates) with manifest v1 and the workflow. ZAP is required on main and absent on PRs. | PERF-G02 remains optional without an approved threshold. |
| 4 | Real hosted execution | PASS | Verified GitHub run `45060111440`, attempt `1`, and the successful CI-G01 and publication steps. [Hosted record](../evidence/README.md#hosted-baseline) | Verify again for the published QEL-7 revision. |
| 5 | Revision-bound evidence | PASS | Matched the downloaded context and run/attempt to GitHub metadata. Recomputed outcomes and receipts against native bytes. [Provenance](../evidence/README.md#hosted-baseline) | Hosted archive access is time-limited. |
| 6 | Controlled detection and recovery | PASS | Revalidated the local accessibility and CSP cases. Both preserved the baseline, observed injected failure and fresh recovery. [Cases](cases/controlled-regressions.md) | Historical native reports remain local-only. |
| 7 | Finding triage and committed remediation | PASS | Re-read the local rule `10021` finding and owner-review disposition, verified the Fastify hook commit, and revalidated the local and later hosted passive results. [Remediation](cases/controlled-regressions.md#historical-zap-rule-10021-remediation) | Original native finding remains local-only. |
| 8 | Independent reproducibility | PASS | Ran both quickstart blocks on PowerShell 7.6.9, Docker Linux engine 29.9.3 and Compose 5.7.0. k6 exited `0`, with 10 requests, 70 passing checks and zero HTTP failures. Owned container and network were gone after teardown, and the native reports remained. [Reproduction](../README.md#quickstart) | Other environments can reproduce using the stated prerequisites. |
| 9 | Accurate limitations | PASS | Compared the README claims with the fixed routes, browser tests, scanner guard and measured calibration. [Scope](../README.md#scope-and-further-reading) · [Calibration](cases/performance-calibration.md) | The scope limits and unqualified latency policy still apply. |
| 10 | Clear evidence navigation | PASS | Checked repository paths and heading anchors, verified hosted references, and labeled ignored reports as local-only. [Evidence index](../evidence/README.md) | The index remains available after archive expiry. |

**Final hosted acceptance (AC-13) is `NOT_RUN`.** After authorized publication, the Coordinator must verify the exact published SHA, fresh CI-G01 outcome, required scenarios and native artifact publication.
