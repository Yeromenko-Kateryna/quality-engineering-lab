# Controlled accessibility and CSP regressions

Run from the repository root with the same prerequisites as the full accessibility and security runners.

```powershell
node regressions/controlled.mjs run
node regressions/controlled.mjs verify <run-id>
```

The command runs the existing full accessibility and security wrappers sequentially. Each uses fresh baseline, injected and recovery SUTs on internal Compose networks. The wrappers configure the SUT before startup. Playwright, axe and the HTTP checker observe the same pages and apply the same policies in all three profiles. Reports survive scoped teardown, and shared SUT image tags remain cached. Full security execution also runs the accepted passive baseline and dependency audit. The controlled security case uses the independent HTTP evidence.

Open `logs/qel6a-<run-id>/case.md` for the technical record and links to the original Playwright, axe and HTTP evidence. `evidence.json` contains the actual native exits, observations, tools, profile and source identities, and artifact SHA-256 hashes. `verify` re-reads all three profiles and checks their receipts against the current artifact bytes. A successful wrapper execution is required. The accessibility comparison covers the tested pages, keyboard path and Chromium configuration. The CSP comparison covers the checked HTTP responses.

## Historical ZAP rule 10021 remediation

The local QEL-4 report `logs/qel4-1d692491f36440168c776784f9228516/baseline/zap.json` recorded missing `X-Content-Type-Options` on `/` and `/search`. Its disposition was unresolved and `INCONCLUSIVE` with ZAP exit `2`. That transcript identifies base commit `45105aa846455c5ab79086be149eb403321bc00e` and records locally added runner files.

Commit `2d0ceecdf24c0426a000920cd0e5dc8b694ff3ed` added a Fastify `onRequest` hook setting `X-Content-Type-Options: nosniff`. The archived local comparison `logs/qel4r-contract-74ae8f1430/` records 16 matched responses with unchanged status, media type, CSP and body hash, with `nosniff` absent before the fix and present afterward. Local rerun `logs/qel4-34f13e747b9e4ef5a83dd4250a1f26f1/baseline/zap-result.json` recorded exit `0`, the same examined pages and no findings. The subsequent hosted reference also examined both pages and reported no findings. [Accepted hosted run](https://github.com/Yeromenko-Kateryna/quality-engineering-lab/actions/runs/45055952023)

The HTTP case exercises a separate regression. `LAB_SECURITY_DEFECT` removes CSP and leaves `nosniff` present. Recovery restores CSP through SUT configuration. Rule 10021 was corrected through the committed `nosniff` hook.
