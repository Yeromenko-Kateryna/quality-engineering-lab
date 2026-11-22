#Requires -Version 7.4
param(
    [ValidatePattern('^[0-9a-f]{32}$', Options = 'None')]
    [string]$CiRun
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$root = Split-Path -Parent $PSScriptRoot
$run = if ($CiRun) { "qel3-$CiRun" } else { "qel3-$([guid]::NewGuid().ToString('N'))" }
$image = "${run}-browser"
$output = (New-Item -ItemType Directory -Path (Join-Path $root "logs/$run")).FullName
$routes = [ordered]@{
    catalogue = '/'; search = '/search'; matching = '/search?q=notebook'
    empty = '/search?q=compass'; invalid = '/search?q='
}
$profiles = [ordered]@{ baseline = 'false' }
if (!$CiRun) { $profiles['injected'] = 'true'; $profiles['recovery'] = 'false' }
$variables = 'LAB_DELAY_MS', 'LAB_SECURITY_DEFECT', 'LAB_A11Y_DEFECT'
$saved = @{}
$projects = [System.Collections.Generic.List[string]]::new()
$runnerBuilt = $false
$outcomes = [ordered]@{}
$exitCode = 2

function Invoke-Docker([string[]]$Arguments, [switch]$AllowFailure) {
    Write-Host ('> ' + (ConvertTo-Json -Compress -InputObject (@('docker') + $Arguments)))
    $lines = @(& docker @Arguments 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
    $lines | Out-Host
    Write-Host "exit=$code"
    if (!$AllowFailure -and $code -ne 0) { throw "Docker exited $code." }
    @{ code = $code; lines = $lines }
}

function Assert-Run($Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
}

function Read-Report([string]$Folder, [string]$Name) {
    $path = Join-Path $Folder "$Name.json"
    Assert-Run ((Test-Path -LiteralPath $path -PathType Leaf) -and (Get-Item -LiteralPath $path).Length -gt 0) "Missing or empty $Name.json."
    Get-Content -Raw -LiteralPath $path | ConvertFrom-Json -AsHashtable
}

function Read-AccessibilityResult([string]$Folder, [int]$NativeExit) {
    $report = Read-Report $Folder 'playwright'
    $specs = @($report['suites'].specs)
    $names = @($routes.Keys) + 'keyboard search'
    Assert-Run ($null -ne $report['errors'] -and $report['errors'].Count -eq 0 -and $specs.Count -eq 6) 'Playwright did not report six tests without global errors.'
    $statuses = [ordered]@{}
    $messages = @()
    foreach ($name in $names) {
        $found = @($specs | Where-Object title -CEQ $name)
        Assert-Run ($found.Count -eq 1 -and $found[0]['tests'].Count -eq 1 -and $found[0]['tests'][0]['results'].Count -eq 1) "Missing or duplicate terminal test for $name."
        $testResult = $found[0]['tests'][0]['results'][0]
        $statuses[$name] = $testResult['status']
        Assert-Run ($statuses[$name] -cin 'passed', 'failed') "Non-terminal or interrupted Playwright result for $name."
        if ($statuses[$name] -ceq 'failed') {
            Assert-Run ($testResult['errors'].Count -gt 0) "Missing failure details for $name."
            foreach ($errorDetail in $testResult['errors']) {
                Assert-Run ($errorDetail['message'] -match 'A11Y:') "Execution error in $name rather than an accessibility assertion."
                $messages += @{ test = $name; message = $errorDetail['message'] }
            }
        }
    }

    $observed = [ordered]@{}
    foreach ($name in $routes.Keys) {
        $axe = Read-Report $Folder "axe-$name"
        $state = Read-Report $Folder "state-$name"
        $expectedUrl = "http://sut:3000$($routes[$name])"
        $expectedStatus = if ($name -ceq 'invalid') { 400 } else { 200 }
        Assert-Run ($state['url'] -ceq $expectedUrl -and $state['status'] -eq $expectedStatus -and
            $state['csp'] -match "default-src 'none'" -and $state['browser'] -and $state['node'] -and
            $axe['url'] -ceq $expectedUrl -and $axe['testEngine']['name'] -ceq 'axe-core' -and
            $axe['testEngine']['version'] -ceq '4.11.1' -and $axe['passes'].Count -gt 0) "Incomplete route, CSP or axe evidence for $name."
        foreach ($key in 'passes', 'incomplete', 'inapplicable', 'violations') {
            Assert-Run ($axe[$key] -is [array]) "Missing axe $key results for $name."
        }
        foreach ($finding in $axe['violations']) {
            Assert-Run ($finding['id'] -and $finding['description'] -and $finding['nodes'].Count -gt 0) "Incomplete axe finding for $name."
        }
        $observed[$name] = @{
            state = $state
            blocking = @($axe['violations'] | Where-Object impact -in 'critical', 'serious' | Select-Object id, impact, description, nodes)
            nonblocking = @($axe['violations'] | Where-Object impact -notin 'critical', 'serious' | Select-Object id, impact, description, nodes)
            needsReview = @($axe['incomplete'] | Select-Object -ExpandProperty id)
        }
        if ($observed[$name].blocking.Count -gt 0) {
            Assert-Run ($statuses[$name] -ceq 'failed') "Blocking axe result did not fail $name."
        }
    }
    if ($statuses['keyboard search'] -ceq 'passed') {
        $keyboard = Read-Report $Folder 'keyboard'
        Assert-Run ($keyboard['url'] -ceq 'http://sut:3000/search?q=notebook' -and $keyboard['status'] -eq 200 -and
            $keyboard['stops'].Count -eq 4 -and $keyboard['nextTab']['focusVisible']) 'Incomplete keyboard evidence.'
    }
    $failed = 'failed' -in $statuses.Values
    Assert-Run (($failed -and $NativeExit -eq 1) -or (!$failed -and $NativeExit -eq 0)) 'Native Playwright exit does not match the terminal reports.'
    @{
        outcome = if ($failed) { 'FAIL' } else { 'PASS' }
        statuses = $statuses
        failures = $messages
        states = $observed
    }
}

function Get-OwnedIds([string]$Project) {
    (Invoke-Docker @('ps','-aq','--filter',"label=com.docker.compose.project=$Project")).lines
    (Invoke-Docker @('network','ls','-q','--filter',"label=com.docker.compose.project=$Project")).lines
}

function Remove-Project([string]$Project) {
    $browser = (Invoke-Docker @('ps','-aq','--filter',"label=com.docker.compose.project=$Project",'--filter',"label=qel.run=$run")).lines
    if ($browser) { $null = Invoke-Docker (@('rm','-f') + $browser) }
    $null = Get-OwnedIds $Project
    $null = Invoke-Docker @('compose','-p',$Project,'down','--rmi','local')
    Assert-Run (!(Get-OwnedIds $Project)) "Project $Project still has containers or networks."
    Assert-Run (!(Invoke-Docker @('image','ls','-q','--filter',"reference=$Project-sut")).lines) "Project $Project still has a local SUT image tag."
    $null = $projects.Remove($Project)
}

function Get-ComposeInventory {
    (Invoke-Docker @('ps','-a','--no-trunc','--filter','label=com.docker.compose.project','--format','{{.ID}} {{.Label "com.docker.compose.project"}} {{.State}}')).lines
    (Invoke-Docker @('network','ls','--no-trunc','--filter','label=com.docker.compose.project','--format','{{.ID}} {{.Label "com.docker.compose.project"}}')).lines
}

Push-Location $root
Start-Transcript -Path (Join-Path $output 'execution.txt') | Out-Null
try {
    $revision = git rev-parse HEAD
    Assert-Run ($LASTEXITCODE -eq 0) 'Could not identify the tested revision.'
    Write-Host "Run $run, base revision $revision, PowerShell $($PSVersionTable.PSVersion)"
    Get-FileHash accessibility/Dockerfile,accessibility/package.json,accessibility/package-lock.json,accessibility/playwright.config.ts,accessibility/tests/accessibility.spec.ts,accessibility/Invoke-AccessibilityChecks.ps1,docker-compose.yml,sut/src/app.ts | Format-List Path,Hash | Out-Host
    $null = Invoke-Docker @('version')
    $null = Invoke-Docker @('compose','version')
    $before = @(Get-ComposeInventory | Sort-Object)
    foreach ($variable in $variables) { $saved[$variable] = [Environment]::GetEnvironmentVariable($variable) }
    $env:LAB_DELAY_MS = '0'
    $env:LAB_SECURITY_DEFECT = 'false'

    Assert-Run (!(Invoke-Docker @('image','ls','-q','--filter',"reference=$image")).lines) 'The task runner image tag is already used.'
    $runnerBuilt = $true
    $null = Invoke-Docker @('build','-t',$image,'--label',"qel.run=$run",'accessibility')
    $runnerImageId = (Invoke-Docker @('image','inspect','--format','{{.Id}}',$image)).lines[0]
    $versions = Invoke-Docker @('run','--rm','--network','none','--pull','never',$image,'node','-p','JSON.stringify({node:process.version,playwright:require("@playwright/test/package.json").version,axe:require("axe-core").version})')
    if ($CiRun) { $versions.lines | Set-Content -LiteralPath (Join-Path $output 'versions.json') }

    foreach ($profile in $profiles.Keys) {
        $project = "$run-$profile"
        Assert-Run (!(Get-OwnedIds $project) -and !(Invoke-Docker @('image','ls','-q','--filter',"reference=$project-sut")).lines) "Compose identity $project is already in use."
        $projects.Add($project)
        $env:LAB_A11Y_DEFECT = $profiles[$profile]
        $null = Invoke-Docker @('compose','-p',$project,'build','sut')
    }

    foreach ($profile in $profiles.Keys) {
        $project = "$run-$profile"
        $folder = (New-Item -ItemType Directory -Path (Join-Path $output $profile)).FullName
        $env:LAB_A11Y_DEFECT = $profiles[$profile]
        $record = [ordered]@{ run = $run; profile = $profile; revision = $revision; project = $project; image = $runnerImageId; reportDirectory = $folder; nativeExit = $null; outcome = 'TOOL_ERROR' }
        try {
            if ($IsLinux) {
                chmod a+w -- $folder
                Assert-Run ($LASTEXITCODE -eq 0) 'Could not prepare the owned Playwright output directory.'
            }
            $null = Invoke-Docker @('compose','-p',$project,'up','--no-build','--pull','never','--wait','--wait-timeout','20','sut')
            $id = (Invoke-Docker @('compose','-p',$project,'ps','-q','sut')).lines[0]
            $sutInfo = (Invoke-Docker @('inspect','--format','{"id":{{json .Id}},"owner":{{json (index .Config.Labels "com.docker.compose.project")}},"health":{{json .State.Health.Status}},"image":{{json .Image}}}',$id)).lines[0] | ConvertFrom-Json -AsHashtable
            $network = (Invoke-Docker @('network','inspect','--format','{{json .}}',"${project}_lab")).lines[0] | ConvertFrom-Json -AsHashtable
            Assert-Run ($network['Internal'] -and $network['Labels']['com.docker.compose.project'] -ceq $project -and
                $network['Labels']['com.docker.compose.network'] -ceq 'lab' -and $network['Containers'].Count -eq 1 -and
                $sutInfo['owner'] -ceq $project -and $sutInfo['health'] -ceq 'healthy' -and
                $sutInfo['id'] -in $network['Containers'].Keys) 'Expected one healthy SUT on the owned internal network.'
            $record.sut = $sutInfo
            $record.network = $network['Id']

            $container = "$project-browser"
            $browserRun = Invoke-Docker @('run','--init','--pull','never','--name',$container,'--network',$network['Id'],
                '--label',"com.docker.compose.project=$project",'--label',"qel.run=$run",'--shm-size','256m',
                '--mount',"type=bind,source=$folder,target=/reports",$runnerImageId) -AllowFailure
            $record.nativeExit = $browserRun.code
            $browserRun.lines | Set-Content -LiteralPath (Join-Path $folder 'playwright.log')
            $browserInfo = (Invoke-Docker @('inspect','--format','{"project":{{json (index .Config.Labels "com.docker.compose.project")}},"run":{{json (index .Config.Labels "qel.run")}},"network":{{json .HostConfig.NetworkMode}},"ports":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}}}',$container)).lines[0] | ConvertFrom-Json -AsHashtable
            Assert-Run ($browserInfo['project'] -ceq $project -and $browserInfo['run'] -ceq $run -and
                $browserInfo['network'] -ceq $network['Id'] -and $browserInfo['ports'].Count -eq 0 -and
                $browserInfo['mounts'].Count -eq 1 -and $browserInfo['mounts'][0]['Destination'] -ceq '/reports') 'Browser run isolation did not match the owned project.'
            $record.evidence = Read-AccessibilityResult $folder $record.nativeExit
            $record.outcome = $record.evidence.outcome
        } catch {
            $record.diagnostic = $_.Exception.Message
            Write-Host $record.diagnostic
        } finally {
            $outcomes[$profile] = $record
            $record | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $folder 'result.json')
            Write-Host "$profile $($record.outcome) native exit=$($record.nativeExit)"
            Remove-Project $project
        }
    }

    if ($CiRun) {
        $exitCode = switch ($outcomes['baseline'].outcome) { 'PASS' { 0 }; 'FAIL' { 1 }; default { 2 } }
    } else {
    $injected = $outcomes['injected'].evidence
    $nameFailure = @($injected.failures | Where-Object { $_.test -ceq 'search' -and $_.message -match 'A11Y: search input accessible name' })
    $unexpected = @($injected.failures | Where-Object { $_.message -notmatch 'A11Y: (search input accessible name|no serious or critical axe findings)' })
    $labelOnly = $true
    if ($injected) {
        foreach ($stateName in $routes.Keys) {
            $rules = @($injected.states[$stateName].blocking)
            if ($stateName -ceq 'catalogue') {
                $labelOnly = $labelOnly -and $rules.Count -eq 0
            } else {
                $labelOnly = $labelOnly -and $rules.Count -eq 1 -and $rules[0].id -ceq 'label' -and
                    @($rules[0].nodes | Where-Object { '#search-term' -in $_['target'] }).Count -gt 0
            }
        }
    }
    $namePattern = '^\s*- searchbox "Search catalogue"\s*$'
    if ($outcomes['baseline'].outcome -ceq 'PASS' -and $outcomes['injected'].outcome -ceq 'FAIL' -and
        $outcomes['recovery'].outcome -ceq 'PASS' -and $nameFailure.Count -eq 1 -and $unexpected.Count -eq 0 -and $labelOnly -and
        $injected.statuses['keyboard search'] -ceq 'passed' -and
        $injected.states['search'].state['input'] -match '^\s*- searchbox\s*$' -and
        $outcomes['baseline'].evidence.states['search'].state['input'] -match $namePattern -and
        $outcomes['recovery'].evidence.states['search'].state['input'] -match $namePattern) {
        $exitCode = 0
    } elseif ('TOOL_ERROR' -notin @($outcomes.Values.outcome)) {
        $exitCode = 1
    }
    }
    $after = @(Get-ComposeInventory | Sort-Object)
    Assert-Run (($before -join '\n') -ceq ($after -join '\n')) 'Other Compose container or network inventory changed.'
    Write-Host "Other Compose inventory unchanged ($($after.Count) rows)."
    foreach ($profile in $profiles.Keys) {
        $record = $outcomes[$profile]
        if ($record.evidence) { $null = Read-Report $record.reportDirectory 'playwright' }
    }
} catch {
    $exitCode = 2
    Write-Host $_.Exception.Message
} finally {
    try {
        foreach ($project in $projects.ToArray()) { Remove-Project $project }
        if ($runnerBuilt) {
            $owner = Invoke-Docker @('image','inspect','--format','{{index .Config.Labels "qel.run"}}',$image) -AllowFailure
            if ($owner.code -eq 0) {
                Assert-Run ($owner.lines[0] -ceq $run) 'Runner image ownership could not be verified.'
                $null = Invoke-Docker @('image','rm',$image)
            }
        }
    } catch {
        $exitCode = 2
        Write-Host $_.Exception.Message
    } finally {
        foreach ($variable in $saved.Keys) {
            if ($null -eq $saved[$variable]) { Remove-Item -LiteralPath "Env:$variable" -ErrorAction SilentlyContinue }
            else { Set-Item -LiteralPath "Env:$variable" -Value $saved[$variable] }
        }
        Write-Host "QEL-3 wrapper exit=$exitCode. Evidence: $output"
        Stop-Transcript | Out-Null
        Pop-Location
    }
}
exit $exitCode
