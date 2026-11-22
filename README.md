# Quality Engineering Lab

QEL-1 provides a read-only TypeScript/Fastify application for controlled quality engineering checks. It serves an immutable synthetic catalogue and uses no external application services or persistent storage.

QEL-2 adds a local k6 HTTP smoke for the search API.

QEL-3 adds Chromium accessibility and keyboard checks for the catalogue and search pages.

QEL-4 adds a local CSP regression check, a scoped ZAP passive baseline and a separate npm advisory audit.

## Build and start

Use Docker with a Linux engine and the Compose plugin supporting `up --wait --wait-timeout`. The build fetches the pinned Node 24.15.0 image and installs dependencies from the npm lockfile. Run the PowerShell commands below from the repository root. Use a new project name for each independent run.

```powershell
$project = "qel1-$([guid]::NewGuid().ToString('N'))"
docker compose -p $project build sut
docker compose -p $project up --no-build --force-recreate --wait --wait-timeout 20 sut
docker compose -p $project ps -a
```

Proceed after `up` exits successfully. Compose waits for the container's HTTP healthcheck. If startup fails, inspect `docker compose -p $project logs sut` for the diagnostic.

To compile independently with local Node 24 and npm, run `npm --prefix sut ci --no-audit --no-fund` followed by `npm --prefix sut run build`.

## Check HTTP behavior

The default configuration publishes no host ports. Use a disposable Node probe on the project's internal network to reach `http://sut:3000`.

```powershell
$id = docker compose -p $project ps -q sut
$network = docker inspect --format '{{.HostConfig.NetworkMode}}' $id
$image = docker inspect --format '{{.Image}}' $id
$probe = @'
(async () => {
  for (const path of ['/health', '/api/items', '/api/search?q=notebook',
    '/api/search?q=compass', '/api/search?q=', '/', '/search',
    '/search?q=notebook', '/search?q=compass', '/search?q=']) {
    const response = await fetch('http://sut:3000' + path, {
      signal: AbortSignal.timeout(4500)
    });
    console.log(path, response.status, response.headers.get('content-security-policy'), await response.text());
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
'@
$probe | docker run --rm -i --network $network --label "qel.probe.project=$project" $image node -
```

| Request | Expected behavior |
| --- | --- |
| `GET /health` | HTTP 200 with `{"status":"ready"}` |
| `GET /api/items` | HTTP 200 with Field Notebook, Desk Notebook and Brass Ruler in that order |
| `GET /api/search?q=notebook` | HTTP 200 with both notebooks in catalogue order |
| `GET /api/search?q=compass` | HTTP 200 with `{"items":[]}` |
| `GET /api/search?q=` | HTTP 400 with an explicit JSON error |
| `GET /` and `GET /search` | HTML catalogue and search form |
| `GET /search?q=notebook`, `?q=compass`, `?q=` | Matching list, empty-result message and HTTP 400 validation feedback, respectively |

Search matches case-insensitive substrings of item names after trimming surrounding whitespace. Supply a single `q` of 1–80 UTF-16 code units after trimming. Missing API input, repeated parameters, blank terms and overlong terms produce HTTP 400. Opening `/search` without a query displays the form.

## Configure a controlled defect

Set the variable before Compose starts the SUT, and use a fresh project or recreate its SUT. Unset the variable to restore its default. Empty values, unsupported formats and out-of-range values stop startup with a nonzero exit and a diagnostic naming the setting.

| Variable | Default | Accepted values and effect |
| --- | --- | --- |
| `LAB_DELAY_MS` | `0` | Whole decimal milliseconds from `0` to `2000`, without leading zeros or whitespace. Adds a bounded wait to `/api/search` and preserves its response payload. The cap bounds injection. |
| `LAB_A11Y_DEFECT` | `false` | Exact `true` or `false`. With `true`, removes the associated “Search catalogue” label, leaving the field without an accessible name and the form usable. |
| `LAB_SECURITY_DEFECT` | `false` | Exact `true` or `false`. With `true`, omits the CSP response header from the catalogue and search pages. |

The default CSP is `default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. The pages use no scripts, stylesheets or external assets. The search form submits to the same origin. HSTS is outside this HTTP-only contract.

The SUT sends `X-Content-Type-Options: nosniff` on HTML and JSON responses, including the HTTP 400 search page and the health endpoint. The CSP defect switch still omits only CSP.

## Stop the owned project

The SUT has its own project-scoped internal bridge network and no mounted volumes. Inspect the Compose project labels and confirm the IDs belong to your run before teardown. Probe containers using `--rm` are removed on exit.

```powershell
docker ps -aq --filter "label=com.docker.compose.project=$project"
docker network ls -q --filter "label=com.docker.compose.project=$project"
docker compose -p $project down --remove-orphans --rmi local
docker ps -aq --filter "label=com.docker.compose.project=$project"
docker network ls -q --filter "label=com.docker.compose.project=$project"
```

The final two listings should be empty. Use the internal network for runtime checks. This configuration provides no host-browser profile.

## Verification scope

Local verification used Docker Desktop 4.99.0 with Linux engine 29.9.3 and Compose 5.7.0. The internal probe reached the SUT and could not reach the same disposable outside-network listener that a positive-control probe reached. The HTML checks used emitted markup and HTTP headers. The delay observations verified the switch's effect on individual responses. Browser automation, load benchmarks, scanner runs and hosted CI are outside QEL-1.

## Run the k6 search smoke

Use PowerShell 7.4 or later and the Docker prerequisites above. Run from the repository root in a shell without `LAB_*` overrides, including in the Compose environment file. Pull the pinned runner before starting the isolated runtime.

```powershell
$project = "qel2-$([guid]::NewGuid().ToString('N'))"
docker pull ghcr.io/grafana/k6:2.3.0@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8
if ($LASTEXITCODE -ne 0) { throw 'k6 image pull failed' }
docker compose -p $project build sut
if ($LASTEXITCODE -ne 0) { throw 'SUT build failed' }
docker compose -p $project up --no-build --wait --wait-timeout 20 sut
if ($LASTEXITCODE -ne 0) { throw 'SUT did not become ready' }

& ./performance/Invoke-SearchSmoke.ps1 -Project $project -Query notebook
$positiveExit = $LASTEXITCODE
& ./performance/Invoke-SearchSmoke.ps1 -Project $project -Query compass
$negativeExit = $LASTEXITCODE
& ./performance/Invoke-SearchSmoke.ps1 -Project $project -Query notebook
$recoveryExit = $LASTEXITCODE
```

The runner joins only the labeled, internal `lab` network of the supplied project. One virtual user runs `GET http://sut:3000/api/search` for 10 seconds with a one-second minimum iteration duration and a two-second request timeout. Each response must be HTTP 200 with a JSON content type, valid JSON, an `items` array and both notebook IDs. The functional thresholds require every check to pass and zero HTTP failures.

`compass` is a valid query that returns an empty array. The same notebook-ID checks fail, demonstrating assertion sensitivity. This result gives no evidence of a SUT defect or performance regression.

Each invocation creates a fresh ignored directory under `logs/<project>/<query>-<id>/`. Completed runs retain the native `summary.json`, k6 output in `k6.log`, exact runner arguments in `invocation.json` and the local decision in `result.json`.

| Wrapper exit | Decision | Required evidence |
| --- | --- | --- |
| `0` | `PASS` | Native k6 exit `0`, valid summary, completed requests and passing functional thresholds |
| `1` | `FAIL` | Native k6 exit `99` with valid evidence of a functional threshold violation on received HTTP responses |
| `2` | `TOOL_ERROR` | Readiness, transport, runner or evidence error. If readiness fails, the wrapper records a diagnostic and k6 does not start. |

Inspect and remove the owned project as shown in **Stop the owned project**. The wrapper removes its disposable runner on exit, and the host reports survive Compose teardown.

No calibrated p95 threshold exists. This smoke supports no production-capacity claim. Hosted GitHub Actions validation is outside QEL-2.

## Run the accessibility checks

Use PowerShell 7.4+, Git, Docker with a Linux engine, and Compose with `up --wait`. Run from the repository root.

```powershell
& ./accessibility/Invoke-AccessibilityChecks.ps1
$LASTEXITCODE
```

The runner builds the digest-pinned Playwright 1.58.2 Noble image and installs Playwright Test 1.58.2 and axe-core 4.11.1 from the npm lockfile before starting any runtime instance. It then starts separate named Compose projects for baseline, injected missing name and recovery, in that order. Each browser joins only its project's internal `lab` network and writes reports to its own host directory. The orchestration sets all three SUT switches explicitly for each profile. The browser receives no switch configuration.

The suite visits Catalogue, Search, matching results, empty results and the HTTP 400 invalid-input page. It checks rendered feedback and the search input's accessible name. A separate test tabs through the links, field and submit button, types `notebook`, presses Enter, and records focus before and after native GET navigation. It checks Chromium’s keyboard-focus outline without requiring the results page to take focus at a specific element.

axe runs the default full-document rules. Serious and critical violations and mandatory browser assertion failures block the run. Moderate and minor findings and axe's incomplete checks remain in the reports. Playwright evaluates the bundled axe source inside Chromium. Browser CSP bypass is disabled, and the test retains the actual response header. This instrumentation evaluates the rendered document and does not validate whether the page can load or execute its own scripts.

Each run writes to ignored `logs/qel3-<id>/`. The three profile folders contain native `playwright.json`, individual `axe-*.json` scans, response and focus observations, and `result.json` with the native exit and local classification. `execution.txt` records versions, exact Docker commands, readiness and cleanup. The wrapper exits `0` for a verified PASS → FAIL → PASS sequence, `1` for a completed sequence that misses the expected demonstration, or `2` for a tooling or evidence error. The injected run retains its native failing result.

The wrapper cleans up each owned project before starting the next and removes its runner image after the sequence. Reports stay on the host. If the wrapper is forcibly interrupted, use the project identities in `execution.txt` and verify ownership labels before scoped cleanup.

Coverage is limited to automated axe rules and the documented Chromium keyboard and focus checks. It provides no general WCAG conformance result, cross-browser coverage or screen-reader testing.

## Run the controlled security baseline

Use PowerShell 7.4+, Git, Node 24, Docker with a Linux engine, and Compose with `up --wait`. Run from the repository root.

```powershell
& ./security/Invoke-SecurityChecks.ps1
$LASTEXITCODE
```

The runner pulls digest-pinned ZAP 2.17.0 and Node 24.15.0 images before starting the SUTs. It runs the same HTTP checker in three fresh Compose projects. Only the injected project has `LAB_SECURITY_DEFECT=true`. Delay remains `0` and the accessibility switch remains `false` throughout. Each HTML state must return the expected status, `text/html`, exactly one approved CSP header, and exactly one `X-Content-Type-Options: nosniff` header. The checker also verifies HTTP 200, `application/json`, and `nosniff` on `/health`, `/api/items` and `/api/search?q=notebook`. It records body hashes so the runner can compare responses across profiles. In the injected profile, the five HTML responses must omit CSP and all eight responses must retain `nosniff`.

The fixed origin is `http://sut:3000`. The permitted scanner requests are GET `/`, `/search`, `/search?q=notebook`, `/search?q=compass`, and `/search?q=`. The last route returns HTTP 400. The passive spider begins at `/` and reports the pages it actually examines. The runner requires evidence of scanning both `/` and `/search`, the routes originally affected by ZAP rule `10021`. API endpoints and readiness are checked only by the direct HTTP probe on `lab`. Other query parameters, duplicate parameters and redirects are outside the scan.

ZAP joins a project-owned internal scanner network. Only the temporary request guard also joins the SUT's internal `lab` network. The scanner resolves `sut` to the guard, which forwards exact authorized requests to the inspected SUT bridge address. It rejects redirects before returning a location to the scanner and caps upstream requests at 32. The parser and loopback fixtures exercise forbidden URLs, discovered links and redirects. Docker TCP probes verify that a direct connection from the scanner network to the SUT bridge address fails while the same listener remains reachable from `lab`.

The packaged ZAP Baseline uses its exact context and in-scope passive analysis. The traditional spider is limited to one minute, depth two and five children per node. Form processing and robots/sitemap discovery are disabled. ZAP startup and passive processing waits use one-minute limits, and the process has a 160-second deadline plus a five-second termination grace period. The report check requires recorded URLs, guard observations and an empty passive queue.

The dependency check uses `npm audit --package-lock-only --json --registry=https://registry.npmjs.org/` from a separate Docker bridge, with read-only mounts of the manifest and lockfile, retries disabled and a finite request timeout. An offline control exercises advisory-service failure. Audit findings are time-dependent, and suggested fixes are recorded for review.

Evidence stays under ignored `logs/qel4-<id>/`. Each profile contains HTTP observations and the CSP verdict. The baseline folder also contains native `zap.json`, scanner logs, guard request observations and finding dispositions. The run root contains npm JSON, lockfile identity, the offline control, scope checks and a transcript with exact invocations and native exits.

ZAP exit `0` means successful baseline completion, `1` a configured FAIL-level alert, `2` warnings, and `3` an execution error. The local validator requires evidence in addition to the native exit. It records unresolved findings as `INCONCLUSIVE`; missing or corrupt outputs and failed tool execution are `TOOL_ERROR`. The wrapper exits `0` for a completed gate with no unresolved policy dispositions, `1` when findings need review, and `2` for incomplete or failed verification. The expected injected CSP failure retains its own exit `1` and `FAIL`.

The runner checks labels before removing its scanner, guard, internal networks, SUT containers and local SUT image tags. The pinned base images remain in the local cache. Reports survive teardown.

This limited security baseline provides no penetration-test result or security certification.

## Run CI evidence checks locally

Use Node 24, PowerShell 7.4+, Git, Docker with a Linux engine and Compose. Run from the repository root with access to the pinned image registries and the npm advisory service.

```powershell
node --test ci/contracts.test.mjs
node ci/run.mjs local pr
node ci/run.mjs local main
```

The `QEL quality evidence` workflow runs on pull requests targeting `main` and pushes to `main`. The required job is `Required quality gate (CI-G01)`. It uses `ubuntu-24.04`, a 30-minute limit, `contents: read` and checkout without persisted credentials. Checkout 5.0.0 and setup-node 5.0.0 are pinned Node 24 actions. Setup installs Node 24.15.0 and disables dependency caching. Upload-artifact 4.6.2 is pinned for GitHub-hosted artifact publication. The Ubuntu runner supplies PowerShell and Docker Compose.

| Scenario | Policy | PR | Main |
| --- | --- | --- | --- |
| `search_smoke` | `PERF-G01` | Required | Required |
| `axe-baseline` | `A11Y-G01` | Required | Required |
| `keyboard-baseline` | `A11Y-G02` | Required | Required |
| `csp-baseline` | `SEC-G01` | Required | Required |
| `zap-baseline` | `SEC-G01` | Intentionally absent, recorded as `NOT_RUN` | Required |
| `npm-audit` | `DEP-G01` | Required | Required |
| `latency-comparison` | `PERF-G02` | Optional, `NOT_RUN` | Optional, `NOT_RUN` |

The versioned manifest is `ci/manifest.json`. Both paths validate the Compose configuration and run the evidence contract tests before building healthy SUTs. CI uses baseline-only accessibility and security invocations. The individual runner commands above still execute the full local profile sequences. The Linux path uses the platform Docker CLI and prepares only freshly owned report directories for container writers. Security scanning retains the isolated target, gateway and bounded passive configuration. The npm audit still runs separately.

Each execution writes to an ignored `logs/qel5-<namespace>/bundle/`. `native/` holds the k6 summary and diagnostics, Playwright and axe reports, HTTP observations, applicable ZAP report and dispositions, and npm audit JSON. `executions.json` separates wrapper state and exit from native exits. Version-1 receipts record the scenario, dimension, policy and policy version, outcome, actual native exit, timestamp, environmental and tool versions, and hashed artifact references. `context.json` records the checked-out SHA, PR head and event SHA separately, real run ID and attempt or local identifier, worktree status, source fingerprint and lockfile hash.

`preliminary.json` records local evidence validation. The final decision revalidates receipts and artifacts, rejects missing or contradictory evidence, and applies required-state precedence in this order: `FAIL`, `TOOL_ERROR`, `INCONCLUSIVE`, `NOT_RUN`, `PASS`. Optional outcomes stay visible. Missing receipts are evidence errors. An explicit skip records the reason. To diagnose incomplete evidence, inspect the scenario receipt, then the corresponding native and stage logs.

After ordinary test failures the workflow still prepares and uploads the bundle with 14-day retention and missing-file behavior set to `error`. The final `CI-G01` step requires a successful upload and matching action-provided artifact ID and URL. It records the decision and publication outputs in the workflow summary. Independent retrieval is a separate verification step. Local commands return the local validation result and record publication as `NOT_RUN`.

Names are derived from GitHub run, attempt and job identity or a local UUID. Cleanup checks known project names and Docker ownership labels before removing residual resources, and runs even after ordinary failures. Immediate runner termination may prevent cleanup. No calibrated latency result, WCAG conformance, broad security certification or hosted acceptance is implied by local output.
