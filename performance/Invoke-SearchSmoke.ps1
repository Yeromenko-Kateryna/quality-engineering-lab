#Requires -Version 7.4
param(
    [Parameter(Mandatory)]
    [ValidateScript({ $_ -cmatch '^qel2-[0-9a-f]{32}$' })]
    [string]$Project,

    [ValidateSet('notebook', 'compass', IgnoreCase = $false)]
    [string]$Query = 'notebook'
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$image = 'ghcr.io/grafana/k6:2.3.0@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8'
$expectedChecks = @(
    'http_response_received', 'status_is_200', 'content_type_is_json',
    'body_is_valid_json', 'items_is_array', 'contains_field_notebook', 'contains_desk_notebook'
)

function Read-SmokeSummary([string]$Path) {
    if (!(Test-Path -LiteralPath $Path -PathType Leaf) -or (Get-Item -LiteralPath $Path).Length -eq 0) {
        throw 'Native k6 summary is missing or empty.'
    }

    $summary = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json -AsHashtable
    $metrics = $summary['metrics']
    $checks = $summary['root_group']['checks']
    $requests = $metrics['http_reqs']['count']
    $iterations = $metrics['iterations']['count']
    $queryRequests = $metrics["search_smoke_${Query}_requests"]['count']
    $emptyItems = $metrics['search_smoke_empty_items']['count']
    if ($requests -le 0 -or $requests -ne $iterations -or $requests -ne $queryRequests -or
        $null -eq $emptyItems -or $emptyItems -lt 0 -or $emptyItems -gt $requests -or
        $metrics['vus_max']['max'] -ne 1 -or $checks.Count -ne $expectedChecks.Count) {
        throw 'Native summary has inconsistent workload, query or check counts.'
    }

    $passed = 0
    $failed = 0
    foreach ($name in $expectedChecks) {
        $check = $checks[$name]
        if ($check['name'] -cne $name -or $null -eq $check['passes'] -or $null -eq $check['fails'] -or
            $check['passes'] -lt 0 -or $check['fails'] -lt 0 -or $check['passes'] + $check['fails'] -ne $requests) {
            throw "Native summary is missing consistent counts for $name."
        }
        $passed += $check['passes']
        $failed += $check['fails']
    }

    # The native --summary-export booleans indicate violations. For the
    # http_req_failed rate, a native "pass" counts a true failure sample.
    $requestFailures = $metrics['http_req_failed']['passes']
    $checkViolation = $metrics['checks']['thresholds']['rate==1']
    $httpViolation = $metrics['http_req_failed']['thresholds']['rate==0']
    if ($checkViolation -isnot [bool] -or $httpViolation -isnot [bool] -or
        $null -eq $requestFailures -or $null -eq $metrics['http_req_failed']['fails'] -or
        $requestFailures + $metrics['http_req_failed']['fails'] -ne $requests -or
        $requestFailures -ne $checks['status_is_200']['fails'] -or
        $metrics['checks']['passes'] -ne $passed -or $metrics['checks']['fails'] -ne $failed -or
        $checkViolation -ne ($failed -gt 0) -or $httpViolation -ne ($requestFailures -gt 0)) {
        throw 'Native threshold results do not match the observed checks and HTTP failures.'
    }

    @{
        requests = $requests
        iterations = $iterations
        checksPassed = $passed
        checksFailed = $failed
        httpResponsesMissing = $checks['http_response_received']['fails']
        httpFailures = $requestFailures
        emptyItems = $emptyItems
        thresholds = @{ 'checks rate==1' = !$checkViolation; 'http_req_failed rate==0' = !$httpViolation }
    }
}

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $PSScriptRoot 'search-smoke.js'
$run = "$Query-$([guid]::NewGuid().ToString('N'))"
$output = (New-Item -ItemType Directory -Path (Join-Path $root "logs/$Project/$run")).FullName
$report = Join-Path $output 'summary.json'
$result = [ordered]@{
    policy = 'PERF-G01'
    project = $Project
    scenario = 'search_smoke'
    query = $Query
    outcome = 'TOOL_ERROR'
    k6ExitCode = $null
    summary = $null
}
$exitCode = 2

try {
    $networkName = "${Project}_lab"
    $ids = @(docker ps -q --no-trunc --filter "label=com.docker.compose.project=$Project" --filter 'label=com.docker.compose.service=sut' --filter 'health=healthy')
    if ($LASTEXITCODE -ne 0 -or $ids.Count -ne 1) {
        throw "Expected one healthy SUT in $Project. Check Docker access and Compose readiness."
    }

    $networkJson = docker network inspect --format '{{json .}}' $networkName
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the project network.' }
    $network = $networkJson | ConvertFrom-Json -AsHashtable
    if ($network['Internal'] -ne $true -or
        $network['Labels']['com.docker.compose.project'] -cne $Project -or
        $network['Labels']['com.docker.compose.network'] -cne 'lab' -or
        $ids[0] -notin $network['Containers'].Keys) {
        throw 'The healthy SUT must be on the project-owned internal lab network.'
    }

    $dockerArgs = @(
        'run', '--rm', '--pull', 'never', '--name', "$Project-$run",
        '--network', $network['Id'], '--label', "com.docker.compose.project=$Project",
        '--label', 'qel.performance=search_smoke',
        '--mount', "type=bind,source=$source,target=/smoke.js,readonly",
        '--mount', "type=bind,source=$output,target=/output",
        $image, 'run', '--quiet', '--no-color', '--no-usage-report', '--env', "QEL_QUERY=$Query",
        '--summary-export=/output/summary.json', '/smoke.js'
    )
    [ordered]@{
        command = @('docker') + $dockerArgs
        project = $Project
        sut = $ids[0]
        network = $networkName
        networkId = $network['Id']
        target = "http://sut:3000/api/search?q=$Query"
        scriptSha256 = (Get-FileHash -LiteralPath $source).Hash
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $output 'invocation.json')

    & docker @dockerArgs 2>&1 | Tee-Object -FilePath (Join-Path $output 'k6.log') | Out-Host
    $result.k6ExitCode = $LASTEXITCODE
    $result.summary = Read-SmokeSummary $report
    $data = $result.summary
    $violated = $false -in $data.thresholds.Values
    if ($data.httpResponsesMissing -gt 0) {
        throw 'At least one request did not receive an HTTP response from the SUT.'
    }
    if ($result.k6ExitCode -eq 0 -and !$violated) {
        $result.outcome = 'PASS'
        $exitCode = 0
    } elseif ($result.k6ExitCode -eq 99 -and $violated) {
        $result.outcome = 'FAIL'
        $exitCode = 1
    } else {
        throw 'Native exit and functional thresholds do not establish a completed smoke decision.'
    }
} catch {
    $result.diagnostic = $_.Exception.Message
}

$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'result.json')
Write-Host "$($result.outcome) $Project/$run (wrapper exit $exitCode, native k6 exit $($result.k6ExitCode))"
if ($result.diagnostic) { Write-Host $result.diagnostic }
exit $exitCode
