# Controlled accessibility and CSP regressions

Run from the repository root with the [local runner prerequisites](../local-checks.md).

```powershell
node regressions/controlled.mjs run
$runId = Read-Host 'Run ID printed above'
node regressions/controlled.mjs verify $runId
```

The command runs the existing full accessibility and security wrappers sequentially. Each uses fresh baseline, injected and recovery SUTs on internal Compose networks. The wrappers configure the SUT before startup. Playwright, axe and the HTTP checker observe the same pages and apply the same policies in all three profiles. Reports survive scoped teardown, and shared SUT image tags remain cached. Full security execution also runs the accepted passive baseline and dependency audit. The controlled security case uses the independent HTTP evidence.

**LOCAL-ONLY — NOT PUBLICLY RETRIEVABLE.** A new run writes `logs/qel6a-<run-id>/case.md` and `evidence.json`. The JSON binds native exits, tools, source and profile identities, and artifact SHA-256 hashes. `verify` re-reads each profile and checks the receipts against the native bytes. [Verified run IDs and evidence status](../../evidence/README.md#local-controlled-regressions)

## Accessibility

Baseline **PASS** (exit `0`) showed `Search catalogue` as the accessible name of `#search-term`. Injection removed the label and produced **FAIL** (exit `1`). Playwright observed an unnamed searchbox and failed the accessible-name assertion. axe reported `label` on the initial search, matching, empty and invalid states. Catalogue and keyboard checks still passed. A fresh recovery restored the name and returned **PASS** (exit `0`). The evidence covers the tested Chromium pages and keyboard path. [Playwright and axe assertions](../../accessibility/tests/accessibility.spec.ts)

## CSP

Baseline **PASS** (exit `0`) verified exactly `default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` on the five HTML states, including the HTTP 400 response. Injection removed CSP from those states and the independent HTTP checker returned **FAIL** (exit `1`). Status, media type and body hashes matched across profiles, and all eight HTTP responses retained `X-Content-Type-Options: nosniff`. Recovery restored CSP and returned **PASS** (exit `0`). [Independent HTTP checker](../../security/scope.mjs)

## Historical ZAP rule 10021 remediation

The local QEL-4 report `logs/qel4-1d692491f36440168c776784f9228516/baseline/zap.json` recorded missing `X-Content-Type-Options` on `/` and `/search`. The finding remained unresolved pending owner review and the run was `INCONCLUSIVE` with ZAP exit `2`. The transcript identifies base commit `45105aa846455c5ab79086be149eb403321bc00e` and records locally added runner files.

Commit `2d0ceecdf24c0426a000920cd0e5dc8b694ff3ed` added a Fastify `onRequest` hook setting `X-Content-Type-Options: nosniff`. The local comparison `logs/qel4r-contract-74ae8f1430/` records 16 matched responses with unchanged status, media type, CSP and body hash, with `nosniff` absent before the fix and present afterward. Local rerun `logs/qel4-34f13e747b9e4ef5a83dd4250a1f26f1/baseline/zap-result.json` recorded exit `0`, the same examined pages and no findings. These earlier reports remain local-only. The later hosted baseline examined both pages and reported no findings. [Remediation commit](https://github.com/Yeromenko-Kateryna/quality-engineering-lab/commit/2d0ceecdf24c0426a000920cd0e5dc8b694ff3ed) · [Hosted evidence](../../evidence/README.md#hosted-baseline)

The HTTP case exercises a separate regression. `LAB_SECURITY_DEFECT` removes CSP and leaves `nosniff` present. Recovery restores CSP through SUT configuration. Rule 10021 was corrected through the committed `nosniff` hook.
