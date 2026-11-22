# Quality Engineering Lab

QEL-1 provides a read-only TypeScript/Fastify application for controlled quality engineering checks. It serves an immutable synthetic catalogue and uses no external application services or persistent storage.

QEL-2 adds a local k6 HTTP smoke for the search API.

QEL-3 adds Chromium accessibility and keyboard checks for the catalogue and search pages.

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
