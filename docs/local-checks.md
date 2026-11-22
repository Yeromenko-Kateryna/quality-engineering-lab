# Local checks and troubleshooting

Start with the [notebook smoke quickstart](../README.md#quickstart). The optional paths below run from the repository root in PowerShell 7.4+ with Git, a Linux Docker engine, and Compose with `up --wait`. The security, CI and QEL-6 commands also need Node 24. Builds use pinned images and lockfile dependencies. The dependency audit uses the npm advisory registry.

## SUT behavior

The [Compose service](../docker-compose.yml) publishes no host ports. On its internal network, `GET /health` returns readiness, `GET /api/items` returns the synthetic catalogue, and `GET /api/search` accepts a single trimmed `q` of 1–80 UTF-16 code units. `notebook` returns both notebooks, `compass` returns an empty list and blank or repeated input returns HTTP 400. `/` and `/search` serve HTML. The search form also exposes matching, empty and invalid HTML responses.

| Startup setting | Default | Accepted values and effect |
| --- | --- | --- |
| `LAB_DELAY_MS` | `0` | Whole decimal from `0` to `2000`, without leading zeros or whitespace. Delays `/api/search` and preserves its payload. |
| `LAB_A11Y_DEFECT` | `false` | Exact `true` or `false`. Removes the label associated with the search input. |
| `LAB_SECURITY_DEFECT` | `false` | Exact `true` or `false`. Omits CSP from HTML responses. |

Invalid values stop startup. Apply changes before starting a fresh SUT. The [controlled runner](../docs/cases/controlled-regressions.md) manages this for the accessibility and CSP cases.

## Local runners

```powershell
& ./accessibility/Invoke-AccessibilityChecks.ps1
& ./security/Invoke-SecurityChecks.ps1
node --test ci/contracts.test.mjs performance/calibration.test.mjs
node ci/run.mjs local pr
node ci/run.mjs local main
```

- The [accessibility wrapper](../accessibility/Invoke-AccessibilityChecks.ps1) runs baseline, injected and recovery in separate projects. Playwright evaluates the bundled axe source in Chromium while retaining the actual CSP response header. Moderate and minor findings and incomplete axe checks stay visible in reports under `logs/qel3-<id>/`.
- The [security wrapper](../security/Invoke-SecurityChecks.ps1) runs the three CSP profiles, passive ZAP and a separate npm audit. The scanner uses a dedicated internal network and a guard that forwards only authorized GETs to the SUT, rejects redirects, and caps upstream requests at 32. The audit uses a separate bridge with read-only package and lockfile inputs. Reports go to `logs/qel4-<id>/`.
- The [k6 smoke wrapper](../performance/Invoke-SearchSmoke.ps1) runs one VU for ten seconds with one-second minimum iteration pacing and a two-second request timeout. Wrapper exit `0` is `PASS`, `1` is a validated functional failure and `2` is `TOOL_ERROR`. While the quickstart project is healthy, changing its smoke command to `-Query compass` exercises the notebook content assertion against a valid empty response.
- The [CI runner](../ci/run.mjs) uses baseline-only accessibility and security runs. Under `logs/qel5-<id>/bundle/`, `context.json` binds source and run identity, `executions.json` records wrapper exits, and `receipts/` binds per-scenario results to native artifact hashes. The required result order is `FAIL`, `TOOL_ERROR`, `INCONCLUSIVE`, `NOT_RUN`, then `PASS`. Local publication is `NOT_RUN`.

## Teardown and inspection

The full wrappers verify and remove their owned containers and networks. For an interrupted run, identify the exact project from its transcript, then verify project labels, service and network names, and checkout before manually removing any residual resources. Use scoped Compose teardown for a verified project. Shared SUT tags and layers remain cached. Reports in ignored `logs/` survive teardown and are local-only. [Cleanup implementation](../ci/docker-cleanup.mjs) · [Evidence index](../evidence/README.md)

The earlier hosted run `45051969856` failed CI-G01 because teardown treated surviving shared-image tags as errors. The accepted correction verifies container and network removal while preserving shared SUT image content. [Historical failed run](https://github.com/Yeromenko-Kateryna/quality-engineering-lab/actions/runs/45051969856)
