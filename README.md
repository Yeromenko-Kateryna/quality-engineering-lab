# Quality Engineering Lab — QA Automation / SDET Portfolio

Quality Engineering Lab (QEL) demonstrates performance, accessibility and security checks against a controlled TypeScript/Fastify catalogue and search app. k6, Playwright with axe-core, an independent HTTP checker and passive OWASP ZAP run in isolated Docker Compose environments. GitHub Actions validates the results and publishes revision-bound evidence.

The verified QEL-7 main run passed **all six required scenarios**. Independent inspection validated **seven receipts and 49/49 artifact references** by SHA-256 and byte size. Start with the [hosted run](https://github.com/Yeromenko-Kateryna/quality-engineering-lab/actions/runs/45065795581), the [execution evidence](#actual-execution-evidence), or the [Quickstart](#quickstart).

---

## Tech Stack

| Area | Tools |
| --- | --- |
| System under test | TypeScript, Fastify, Node.js, HTML and JSON |
| Performance | k6 functional smoke and separate local calibration |
| Accessibility | Playwright, Chromium and axe-core |
| Security | Independent Node.js HTTP assertions, OWASP ZAP Baseline and npm audit |
| Execution and evidence | PowerShell, Docker Compose, GitHub Actions and Node.js receipt validation |

---

## Architecture and System Under Test

```text
Run-owned internal Compose network (no published SUT ports)
  k6 smoke / Playwright + axe / keyboard checks / CSP checker
    → Fastify SUT at http://sut:3000
      └─ Catalogue, search and read-only JSON over synthetic data

Separate internal scanner network
  Passive ZAP → request guard on both networks → Fastify SUT

Separate Docker bridge
  npm audit + read-only lockfile → npm advisory registry

GitHub Actions orchestrates the checks → native reports
  → scenario adapters and validated receipts
  → artifact publication and final CI-G01 decision
```

| Boundary | Implementation and observable contract |
| --- | --- |
| HTML | Catalogue at `/` and search at `/search`, including matching, empty and invalid-input states. [Fastify routes](sut/src/app.ts) |
| JSON | `GET /health` reports readiness, `GET /api/items` returns the fixed catalogue, and `GET /api/search` returns matches or validates the query. [Server entry point](sut/src/server.ts) |
| Isolation | Each run uses a named Compose project and internal network. The ZAP request guard limits the fixed SUT origin, allowed GET routes and request count. [Compose](docker-compose.yml) · [Request guard](security/scope.mjs) |
| Defect injection | Startup switches change SUT behavior. The oracles inspect HTTP and DOM outcomes with the same assertions in baseline, injection and recovery. [Startup settings](docs/local-checks.md#sut-behavior) |

The diagram combines the allowed paths across separate run-owned projects. ZAP reaches the SUT through the guard. npm audit reaches the advisory registry from its separate bridge.

---

## QA Automation Coverage

### Performance Testing

**PERF-G01** runs one virtual user for 10 seconds. The notebook search must return HTTP 200, valid JSON and both expected notebook IDs, with zero HTTP failures. **PERF-G02** is a separate optional latency comparison. The local calibration uses a fixed workload and warm-up, and its numerical comparison remains `INCONCLUSIVE`. [k6 smoke checks](performance/search-smoke.js) · [Calibration protocol](docs/cases/performance-calibration.md)

### Accessibility Testing

**A11Y-G01** checks the catalogue and search states, the accessible name of the search input, and serious or critical axe findings. **A11Y-G02** checks tab order, visible focus and keyboard submission in Chromium. [Playwright and axe assertions](accessibility/tests/accessibility.spec.ts)

### Security Testing

**SEC-G01** uses independent HTTP assertions for the expected Content Security Policy (CSP) and `X-Content-Type-Options: nosniff`. The passive ZAP baseline reaches the SUT through the request guard. **DEP-G01** checks the dependency lockfile against the npm advisory service through a separate bridge. [HTTP assertions and guard](security/scope.mjs) · [Security runner](security/Invoke-SecurityChecks.ps1)

### CI/CD and Evidence Validation

CI runs on PRs targeting `main` and pushes to `main`. The final **CI-G01** decision uses the required scenario results, scoped cleanup evidence, validated receipts and successful artifact publication. [Workflow](.github/workflows/quality.yml) · [Scenario manifest](ci/manifest.json) · [Adapters](ci/adapters.mjs) · [Evidence validator](ci/evidence.mjs)

| Policy and scenario | PR to `main` | Push to `main` | Evidence |
| --- | --- | --- | --- |
| PERF-G01 · `search_smoke` | Required | Required | k6 summary and log |
| A11Y-G01 · `axe-baseline` | Required | Required | Playwright and per-state axe JSON |
| A11Y-G02 · `keyboard-baseline` | Required | Required | Playwright JSON and keyboard observations |
| SEC-G01 · `csp-baseline` | Required | Required | HTTP/header observations |
| SEC-G01 · `zap-baseline` | Absent (`NOT_RUN`) | Required | Passive scan report and request-guard log |
| DEP-G01 · `npm-audit` | Required | Required | Audit JSON and invocation |
| PERF-G02 · `latency-comparison` | Optional | Optional | Local calibration summary and native samples |
| CI-G01 · final decision | Required | Required | Scenario receipts and artifact publication outcome |

---

## Quality Engineering Practices Demonstrated

- Independent assertions driven by observed HTTP responses and browser behavior.
- Controlled defect injection and fresh recovery runs with unchanged assertions.
- Scoped ownership checks before Docker teardown, with shared image content and reports retained.
- Commit-, run- and attempt-bound evidence, with file integrity checked from native bytes.
- Distinct outcomes for valid success (`PASS`), violated assertions (`FAIL`), tooling or evidence errors (`TOOL_ERROR`), unresolved findings or insufficient qualification (`INCONCLUSIVE`), and skipped execution (`NOT_RUN`). [Evidence contract tests](ci/contracts.test.mjs)

---

## Actual Execution Evidence

### Hosted QEL-7 verification

| Record | Verified result |
| --- | --- |
| Revision | `9dfd27d30eb0834a3304a103768760e5426ad0f0`, push to `main` |
| Execution | Run [45065795581](https://github.com/Yeromenko-Kateryna/quality-engineering-lab/actions/runs/45065795581), attempt `1`, workflow `success` |
| CI-G01 | `PASS`. All six required scenarios passed. |
| Optional comparison | Hosted `latency-comparison` recorded `NOT_RUN`. |
| Native archive | Artifact [14771526803](https://github.com/Yeromenko-Kateryna/quality-engineering-lab/actions/runs/45065795581/artifacts/14771526803). All seven receipts and 49/49 referenced file hashes and byte sizes were validated. |

Open `context.json` for provenance, `preliminary.json` for outcomes and `receipts/` for the native paths and checksums. Artifact access can require GitHub authentication. GitHub listed expiry on **2026-12-06 at 20:23 UTC**. The evidence index records this run and preserves the earlier hosted baseline and local cases under their original identities. [Current hosted baseline](evidence/README.md#current-hosted-baseline)

### Local evidence

Historical local runs recorded a successful notebook smoke and recovery, an expected failure of the incompatible `compass` content assertion, and real accessibility and CSP regressions with successful recovery. These reports remain local-only. The sequence results and source links are below. [Controlled regression demonstrations](#controlled-regression-demonstrations) · [Local evidence index](evidence/README.md#local-controlled-regressions)

The later local accessibility wrapper run `qel3-46417977dfa743dc9fbe48e604f5e123` tested `9dfd27d30eb0834a3304a103768760e5426ad0f0`. Its terminal transcript recorded baseline 6/6 passed, injection four failed and two passed, recovery 6/6 passed, and wrapper exit `0`. The counts come from terminal evidence. Independent revalidation of its native reports was outside this review. The historical controlled case `4ea8a3e2f1214b908a9a3c70111b12c0` has its own revision, receipts and local evidence record.

---

## Project Status

**QEL-1 through QEL-7 are accepted**, including final QEL-7 hosted verification at the revision above. The QEL-8 README presentation and QEL-8R documentation corrections are pending independent acceptance and publication. The verified execution applies to the recorded SHA, and the earlier experiments retain their own run identities. [Project brief](PROJECT_BRIEF.md) · [Portfolio definition of done](docs/portfolio-dod.md)

---

## Repository Structure

```text
sut/                     TypeScript/Fastify catalogue and search
performance/             k6 smoke, calibration and eligibility checks
accessibility/           Playwright, axe and keyboard tests
security/                CSP assertions, passive ZAP and npm audit
regressions/             Controlled case execution and verification
ci/                      Scenario manifest, adapters and evidence validation
.github/workflows/       GitHub Actions quality workflow
docs/                    Architecture, case studies and local runbook
evidence/                Tracked evidence index
docker-compose.yml       Isolated SUT service
```

---

## How to Run

### Quickstart

Use a fresh **PowerShell 7.4+** session with Git, Docker running a Linux engine, and Docker Compose with `up --wait`. The build needs access to the base image and lockfile dependencies. This path runs only the notebook smoke.

```powershell
git clone https://github.com/Yeromenko-Kateryna/quality-engineering-lab.git
Set-Location quality-engineering-lab
pwsh --version
docker info --format '{{.OSType}}'
docker compose version
```

Confirm that Docker reports `linux`. From the repository root, run this block in the same PowerShell session.

```powershell
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$project = "qel2-$([guid]::NewGuid().ToString('N'))"
$k6Image = 'ghcr.io/grafana/k6:2.3.0@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8'
$label = "label=com.docker.compose.project=$project"

function Get-LabResources {
    docker ps -a --filter $label --format 'container:{{.Names}}'
    docker network ls --filter $label --format 'network:{{.Name}}'
}

$existingTag = docker image ls --filter "reference=${project}-sut:latest" -q
if ((Get-LabResources) -or $existingTag) { throw "Compose identity is in use: $project" }

$env:LAB_DELAY_MS = '0'
$env:LAB_A11Y_DEFECT = 'false'
$env:LAB_SECURITY_DEFECT = 'false'
try {
    docker pull $k6Image
    docker compose -f docker-compose.yml -p $project build sut
    docker compose -f docker-compose.yml -p $project up --no-build --pull never --wait --wait-timeout 20 sut
    & ./performance/Invoke-SearchSmoke.ps1 -Project $project -Query notebook
    if ($LASTEXITCODE -ne 0) { throw "Smoke wrapper exit: $LASTEXITCODE" }
} finally {
    $expected = "container:$project-sut-1", "network:${project}_lab"
    if (Get-LabResources | Where-Object { $_ -cnotin $expected }) {
        throw "Unexpected project resources. Inspect ownership before teardown: $project"
    }
    docker compose -f docker-compose.yml -p $project down
    if (Get-LabResources) { throw "Owned containers or networks remain: $project" }
}
Get-Content "logs/$project/notebook-*/result.json" -Raw
```

Expect `PASS` and native k6 exit `0`. The run directory also keeps `summary.json`, `k6.log` and `invocation.json`. Teardown leaves the reports and shared build images available. Your generated `logs/` are local-only.

The Quickstart was executed during the earlier QEL-7 local evaluation. QEL-8R checked the command blocks statically. [Recorded reproduction](docs/portfolio-dod.md)

For full-suite commands, runner prerequisites and troubleshooting, see the [local checks guide](docs/local-checks.md).

---

## Controlled Regression Demonstrations

These are historical local executions. The generated native reports remain local-only.

| Experiment | Baseline | Deliberate change | Recovery |
| --- | --- | --- | --- |
| k6 content assertion | `notebook`: 70/70 checks passed, 10 requests, zero HTTP failures | `compass`: 50/70 passed, 20 expected assertion failures. The valid empty result cannot satisfy the notebook content assertions. | `notebook`: 70/70 passed |
| Accessible search name | 6/6 Playwright tests passed | Removing the name caused four tests to fail and two to pass. Axe reported critical rule `label`. | 6/6 passed. The full QEL-3 wrapper exited `0`. |
| CSP header | HTTP assertions passed | Omitting CSP on five HTML states caused the independent checker to fail. Status and content type were preserved, and `nosniff` remained present. | The exact approved CSP was restored and the checker passed. |

The k6 sequence demonstrates assertion sensitivity to different valid content. The accessibility and CSP cases demonstrate injected application defects. [Smoke assertions](performance/search-smoke.js) · [Accessibility case](docs/cases/controlled-regressions.md#accessibility) · [CSP case](docs/cases/controlled-regressions.md#csp)

The k6 sequence is recorded under local project `qel2-94b0e5a46ffb445c97d6ad4745233458`. The accessibility and CSP results use case run `4ea8a3e2f1214b908a9a3c70111b12c0`, with its revision and working-tree fingerprint recorded in the [local evidence index](evidence/README.md#local-controlled-regressions).

**Historical ZAP remediation.** The original local passive scan reported rule `10021` for missing `X-Content-Type-Options` on `/` and `/search`. Commit `2d0ceecdf24c0426a000920cd0e5dc8b694ff3ed` added the Fastify `nosniff` hook. A local rerun and the verified hosted baseline both examined those routes and recorded no findings. [Triage and remediation evidence](docs/cases/controlled-regressions.md#historical-zap-rule-10021-remediation)

---

## Limitations and Scope

- PERF-G01 measures functional HTTP behavior. The three local calibration runs recorded 150 successful measurements each and p95 of 2.870–3.091 ms on an unqualified host. PERF-G02 has no approved numerical threshold, and these samples support no production performance or capacity claim. [Calibration results](docs/cases/performance-calibration.md#observed-baseline)
- Accessibility evidence covers the selected Chromium pages and keyboard path. Full WCAG conformance is outside this coverage.
- The ZAP run provides scoped passive evidence for the controlled SUT. Penetration testing and arbitrary external targets are outside scope. npm audit checks known dependency advisories.
- The documented Compose setup uses an internal network without published SUT ports. Portfolio verification covers the stated lab conditions. Production readiness is outside its scope.

---

## Author

Kateryna Yeromenko · [GitHub](https://github.com/Yeromenko-Kateryna)
