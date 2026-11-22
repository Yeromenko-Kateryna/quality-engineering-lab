# Quality Engineering Lab

QEL-1 provides a read-only TypeScript/Fastify application for controlled quality engineering checks. It serves an immutable synthetic catalogue and uses no external application services or persistent storage.

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
