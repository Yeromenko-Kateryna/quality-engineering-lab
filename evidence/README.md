# Evidence index

## Hosted baseline

| Provenance | Verified record |
| --- | --- |
| Tested commit | `a18f6d6517235f5a89e8717f11ceb94165e51913`, clean checkout, `main` profile |
| Run and attempt | `45060111440`, attempt `1`. [GitHub Actions run](https://github.com/Yeromenko-Kateryna/quality-engineering-lab/actions/runs/45060111440) |
| Workflow and gate | Workflow `success`. CI-G01 `PASS`, with successful publication and gate steps. |
| Required scenarios | `search_smoke`, `axe-baseline`, `keyboard-baseline`, `csp-baseline`, `zap-baseline` and `npm-audit` all `PASS`. |
| Optional scenario | `latency-comparison` recorded `NOT_RUN`. |
| Artifact | `14769122504`, `qel-evidence-abac80cd99369e34741c91607475e145`. [GitHub artifact](https://github.com/Yeromenko-Kateryna/quality-engineering-lab/actions/runs/45060111440/artifacts/14769122504) |
| Verification | Retrieved on **2026-11-22**. Revalidated native reports against all receipts and confirmed tested SHA, run and attempt. |
| Retention | Workflow retention is 14 days. GitHub reported expiry **2026-12-06 19:21 UTC**. Access can also depend on GitHub authentication and repository permissions. |

Start with `context.json`, then open `preliminary.json` and the relevant file in `receipts/`. The receipts identify native reports and SHA-256 hashes. The archive contains baseline Playwright and axe JSON, keyboard observations, the k6 smoke summary, CSP observations, passive ZAP reports and the npm audit. The two controlled regression sequences and the calibration batch are local-only evidence.

After artifact expiry, the run page supplies workflow history and this tracked index preserves the verified revision, outcomes and reproduction paths. The native archive and this textual record have different verification uses. QEL-7 documentation changes require a separate hosted verification at their published revision.

## Local controlled regressions

**LOCAL-ONLY — NOT PUBLICLY RETRIEVABLE.** Case run `4ea8a3e2f1214b908a9a3c70111b12c0` recorded base SHA `cd841e15256ec713b65cccd4badd8092028d2348`, a dirty worktree and source fingerprint `4a5ea38790a53b1e6397510aabeac6b6fe1d6859ea287ba78758d145d258f7b2`. Both sequences revalidated on 2026-11-22. The environment was Windows with PowerShell 7.6.9, Docker Linux engine 29.9.3 and Compose 5.7.0.

| Case and native run | Observed sequence | Native reports |
| --- | --- | --- |
| Accessibility `qel3-4ea8a3e2f1214b908a9a3c70111b12c0` | `PASS → FAIL → PASS`, exits `0 / 1 / 0`. Playwright 1.58.2 and axe-core 4.11.1 in Chromium detected the missing searchbox name and `label` violation. | `playwright.json`, `axe-*.json`, `state-search.json`, `keyboard.json` |
| CSP `qel4-4ea8a3e2f1214b908a9a3c70111b12c0` | `PASS → FAIL → PASS`, exits `0 / 1 / 0`. The Node 24.15.0 HTTP checker detected omitted CSP on five HTML responses while `nosniff` remained present. | `http-csp.json`, `http-invocation.json`, `csp-result.json` |

Run `node regressions/controlled.mjs run` to reproduce. The generated `logs/qel6a-<run-id>/evidence.json` indexes the native reports and hashes. [Source and reproduction](../docs/cases/controlled-regressions.md)

## Historical ZAP remediation

**LOCAL-ONLY — NOT PUBLICLY RETRIEVABLE.** Run `qel4-1d692491f36440168c776784f9228516` retained rule `10021` for `/` and `/search` as `INCONCLUSIVE`, pending owner review. The local rerun `qel4-34f13e747b9e4ef5a83dd4250a1f26f1` completed at native exit `0` after the Fastify hook added `nosniff`. The hosted baseline above later examined both routes and recorded no findings. [Remediation commit](https://github.com/Yeromenko-Kateryna/quality-engineering-lab/commit/2d0ceecdf24c0426a000920cd0e5dc8b694ff3ed) · [Case and source](../docs/cases/controlled-regressions.md#historical-zap-rule-10021-remediation)

## Local performance calibration

**LOCAL-ONLY — NOT PUBLICLY RETRIEVABLE.** Batch `15e9becfef4e4b9aa215760ed37cfaad` recorded base SHA `cd841e15256ec713b65cccd4badd8092028d2348` and source fingerprint `1c16599912f6a7e8d1736314fa31c78aa047323f5823317452e62adf261fcdd2`. Three 5 VU × 30 second runs followed five warm-up requests each. Each run recorded 150 successful measurements and zero HTTP failures. The p50 values were 1.404, 1.616 and 1.597 ms, and the corresponding p95 values were 2.870, 2.902 and 3.091 ms.

The unqualified local host and the absence of an approved numerical threshold leave PERF-G02 `INCONCLUSIVE`. The optional injected delay experiment was `NOT_RUN`. Run `node performance/calibrate.mjs run` to generate a new batch with native samples, summaries and hashes. [Protocol and results](../docs/cases/performance-calibration.md)
