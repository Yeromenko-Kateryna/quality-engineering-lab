#Requires -Version 7.4
param(
    [ValidatePattern('^[0-9a-f]{32}$', Options = 'None')]
    [string]$CiRun,
    [ValidateSet('pr','main')]
    [string]$CiProfile = 'main'
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$root = Split-Path -Parent $PSScriptRoot
$run = if ($CiRun) { "qel4-$CiRun" } else { "qel4-$([guid]::NewGuid().ToString('N'))" }
$output = (New-Item -ItemType Directory -Path (Join-Path $root "logs/$run")).FullName
$nodeImage = 'node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d'
$zapImage = 'ghcr.io/zaproxy/zaproxy:2.17.0@sha256:9624669db72f54d86c4b46a7064518bd9bf79d8c61a4c31befa9923489f328af'
$sourceMount = "type=bind,source=$PSScriptRoot,target=/qel,readonly"
$noProxy = foreach ($name in 'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy') {
    '--env'
    "$name="
}
$variables = 'LAB_DELAY_MS', 'LAB_A11Y_DEFECT', 'LAB_SECURITY_DEFECT'
$saved = @{}
$profiles = [ordered]@{ baseline = 'false' }
if (!$CiRun) { $profiles['injected'] = 'true'; $profiles['recovery'] = 'false' }
$scanRequired = !$CiRun -or $CiProfile -ceq 'main'
$dockerCommand = (Get-Command docker -CommandType Application | Select-Object -First 1).Path
$cspResults = [ordered]@{}
$projects = [System.Collections.Generic.List[string]]::new()
$exitCode = 2

function Invoke-Tool([string]$Command, [string[]]$Arguments, [string]$Save, [switch]$SeparateError, [switch]$AllowFailure) {
    Write-Host ('> ' + (ConvertTo-Json -Compress -InputObject (@($Command) + $Arguments)))
    if ($SeparateError) {
        $lines = @(& $Command @Arguments 2> "$Save.stderr" | ForEach-Object { "$_" })
    } else {
        $lines = @(& $Command @Arguments 2>&1 | ForEach-Object { "$_" })
    }
    $code = $LASTEXITCODE
    if ($Save) { Set-Content -LiteralPath $Save -Value $lines; Write-Host "output=$Save" }
    else { $lines | Out-Host }
    Write-Host "exit=$code"
    if (!$AllowFailure -and $code -ne 0) { throw "$Command exited $code." }
    @{ code = $code; lines = $lines }
}

function Docker([string[]]$Arguments, [string]$Save, [switch]$AllowFailure) {
    Invoke-Tool $dockerCommand $Arguments -Save $Save -AllowFailure:$AllowFailure
}

function Confirm($Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
    Write-Host "PASS $Message"
}

function Evidence([string]$Kind, [string]$Path, [int]$Code, [string]$ResultPath, [string[]]$Extra = @()) {
    $result = Invoke-Tool 'node' (@('security/evidence.mjs',$Kind,$Path,"$Code") + $Extra) -Save $ResultPath -AllowFailure
    $data = ($result.lines -join "`n") | ConvertFrom-Json -AsHashtable
    Write-Host "$Kind outcome=$($data.outcome) $($data.diagnostic)"
    $data
}

function Owned-Resources([string]$Project) {
    (Docker @('ps','-aq','--filter',"label=com.docker.compose.project=$Project")).lines
    (Docker @('network','ls','-q','--filter',"label=com.docker.compose.project=$Project")).lines
}

function Remove-Profile([string]$Project) {
    $extras = (Docker @('ps','-aq','--filter',"label=com.docker.compose.project=$Project",'--filter',"label=qel.run=$run")).lines
    if ($extras) { $null = Docker (@('rm','-f') + $extras) }
    $front = (Docker @('network','ls','-q','--filter',"label=com.docker.compose.project=$Project",'--filter',"label=qel.run=$run")).lines
    if ($front) { $null = Docker (@('network','rm') + $front) }
    $null = Owned-Resources $Project
    $null = Docker @('compose','-p',$Project,'down','--rmi','local')
    Confirm (!(Owned-Resources $Project) -and !(Docker @('image','ls','-q','--filter',"reference=$Project-sut")).lines) "Owned resources removed for $Project"
    $null = $projects.Remove($Project)
}

function Inventory {
    (Docker @('ps','-a','--no-trunc','--filter','label=com.docker.compose.project','--format','{{.ID}} {{.Label "com.docker.compose.project"}} {{.State}}')).lines
    (Docker @('network','ls','--no-trunc','--filter','label=com.docker.compose.project','--format','{{.ID}} {{.Label "com.docker.compose.project"}}')).lines
}

function Invoke-PassiveBaseline([string]$Project, $Lab, [string]$SutIp, [string]$Folder) {
    if ($IsLinux) {
        chmod a+w -- $Folder
        Confirm ($LASTEXITCODE -eq 0) 'Owned ZAP output directory is writable'
    }
    $frontId = (Docker @('network','create','--internal','--label',"com.docker.compose.project=$Project",'--label',"qel.run=$run","$Project-scan")).lines[0]
    $front = (Docker @('network','inspect','--format','{{json .}}',$frontId)).lines[0] | ConvertFrom-Json -AsHashtable
    Confirm ($front.Internal -and $front.Labels['qel.run'] -ceq $run -and $front.Labels['com.docker.compose.project'] -ceq $Project -and $front.Containers.Count -eq 0) 'Scanner network is owned, internal and initially empty'
    $gateway = "$Project-gateway"
    $labels = @('--label',"com.docker.compose.project=$Project",'--label',"qel.run=$run")
    $null = Docker (@('run','-d','--pull','never','--name',$gateway,'--network',$frontId,'--network-alias','sut','--mount',$sourceMount) +
        $labels + @($nodeImage,'node','/qel/scope.mjs','guard',$SutIp))
    $null = Docker @('network','connect',$Lab.Id,$gateway)
    $gatewayMeta = (Docker @('inspect','--format','{"networks":{{json .NetworkSettings.Networks}},"ports":{{json .HostConfig.PortBindings}}}',$gateway)).lines[0] | ConvertFrom-Json -AsHashtable
    Confirm ($gatewayMeta.networks.Count -eq 2 -and $gatewayMeta.ports.Count -eq 0 -and
        $frontId -in $gatewayMeta.networks.Values.NetworkID -and $Lab.Id -in $gatewayMeta.networks.Values.NetworkID) 'Only the unpublished gateway joins both internal networks'

    foreach ($probe in @(@{network=$Lab.Id; name='reachable-before'; code=0}, @{network=$frontId; name='direct-blocked'; code=1}, @{network=$Lab.Id; name='reachable-after'; code=0})) {
        $observed = Docker @('run','--rm','--pull','never','--network',$probe.network,'--mount',$sourceMount,$nodeImage,'node','/qel/scope.mjs','connect',$SutIp) -AllowFailure -Save (Join-Path $Folder "$($probe.name).json")
        $observation = $observed.lines[0] | ConvertFrom-Json
        Confirm ($observed.code -eq $probe.code -and $observation.destination -ceq $SutIp -and
            (($probe.code -eq 0 -and $observation.connected) -or ($probe.code -eq 1 -and !$observation.connected -and $observation.code -in 'ENETUNREACH','EHOSTUNREACH','ETIMEDOUT'))) "TCP control $($probe.name)"
    }

    $context = Join-Path $PSScriptRoot 'zap.context'
    $hook = Join-Path $PSScriptRoot 'zap-observe.py'
    $null = Docker @('run','--rm','--pull','never','--network','none','--mount',$sourceMount,$nodeImage,'node','/qel/scope.mjs','preflight')
    $zap = "$Project-zap"
    $options = '-silent -config pscans.scanOnlyInScope=true -config spider.parseRobotsTxt=false -config spider.parseSitemapXml=false -config spider.processform=false -config spider.postform=false -config spider.maxDepth=2 -config spider.maxChildren=5'
    $null = Docker (@('create','--init','--no-healthcheck','--pull','never','--name',$zap,'--network',$frontId) + $labels + $noProxy +
        @('--mount',"type=bind,source=$Folder,target=/zap/wrk",
          '--mount',"type=bind,source=$context,target=/zap/wrk/zap.context,readonly",
          '--mount',"type=bind,source=$hook,target=/zap/wrk/zap-observe.py,readonly",
          $zapImage,'timeout','--kill-after=5s','160s','zap-baseline.py','-t','http://sut:3000/',
          '-n','zap.context','-m','1','-T','1','-J','zap.json','-d','--autooff','--hook=/zap/wrk/zap-observe.py','-z',$options))
    $runner = (Docker @('inspect','--format','{"mode":{{json .HostConfig.NetworkMode}},"ports":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}},"project":{{json (index .Config.Labels "com.docker.compose.project")}}}',$zap)).lines[0] | ConvertFrom-Json -AsHashtable
    Confirm ($runner.mode -ceq $frontId -and $runner.ports.Count -eq 0 -and $runner.mounts.Count -eq 3 -and
        $runner.project -ceq $Project -and @($runner.mounts | Where-Object RW).Count -eq 1) 'ZAP container has only the owned scanner network and controlled mounts'
    $log = Join-Path $Folder 'zap.log'
    $gatewayLog = Join-Path $Folder 'gateway.jsonl'
    $null = Docker @('start','-a',$zap) -Save $log -AllowFailure
    $state = (Docker @('inspect','--format','{{json .State}}',$zap)).lines[0] | ConvertFrom-Json -AsHashtable
    $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Folder 'zap-process.json')
    Confirm ($state.Status -ceq 'exited') 'ZAP container reached a terminal state'
    $null = Docker @('logs',$gateway) -Save $gatewayLog
    Evidence zap (Join-Path $Folder 'zap.json') $state.ExitCode (Join-Path $Folder 'zap-result.json') @($log,$gatewayLog)
}

function Invoke-Audit([string]$Network, [string]$Name) {
    $manifest = Join-Path $root 'sut/package.json'
    $lock = Join-Path $root 'sut/package-lock.json'
    $file = Join-Path $output "$Name.json"
    $arguments = @('run','--rm','--pull','never','--network',$Network,'--workdir','/locked') + $noProxy + @(
        '--mount',"type=bind,source=$manifest,target=/locked/package.json,readonly",
        '--mount',"type=bind,source=$lock,target=/locked/package-lock.json,readonly",
        $nodeImage,'npm','audit','--package-lock-only','--json','--registry=https://registry.npmjs.org/',
        '--fetch-retries=0','--fetch-timeout=15000','--no-update-notifier')
    $executed = Invoke-Tool $dockerCommand $arguments -Save $file -SeparateError -AllowFailure
    [ordered]@{ utc = [DateTime]::UtcNow.ToString('o'); lockSha256 = (Get-FileHash -LiteralPath $lock).Hash; command = @($dockerCommand) + $arguments; nativeExit = $executed.code } |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $output "$Name-invocation.json")
    Evidence audit $file $executed.code (Join-Path $output "$Name-result.json")
}

Push-Location $root
Start-Transcript -Path (Join-Path $output 'execution.txt') | Out-Null
try {
    $revision = git rev-parse HEAD
    Confirm ($LASTEXITCODE -eq 0) 'Git revision recorded'
    Write-Host "Run $run, base revision $revision, PowerShell $($PSVersionTable.PSVersion)"
    Get-FileHash security/*.mjs,security/*.ps1,security/*.context,security/*.py,sut/package-lock.json,sut/src/app.ts,docker-compose.yml | Format-List Path,Hash | Out-Host
    $null = Docker @('version')
    $null = Docker @('compose','version')
    $before = @(Inventory | Sort-Object)
    $null = Invoke-Tool 'node' @('--version')
    $null = Docker @('pull',$nodeImage)
    if ($scanRequired) { $null = Docker @('pull',$zapImage) }
    $nodeVersion = (Docker @('run','--rm','--pull','never','--network','none',$nodeImage,'node','--version')).lines[0]
    $npmVersion = (Docker @('run','--rm','--pull','never','--network','none',$nodeImage,'npm','--version')).lines[0]
    if ($CiRun) {
        @{ node = $nodeVersion; npm = $npmVersion; nodeImage = $nodeImage; zapImage = $zapImage } |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'versions.json')
    }
    $null = Docker @('run','--rm','--pull','never','--network','none','--mount',$sourceMount,$nodeImage,'node','--test','/qel/scope.test.mjs') -Save (Join-Path $output 'scope-tests.txt')

    foreach ($name in $variables) { $saved[$name] = [Environment]::GetEnvironmentVariable($name) }
    $env:LAB_DELAY_MS = '0'
    $env:LAB_A11Y_DEFECT = 'false'
    foreach ($profile in $profiles.Keys) {
        $project = "$run-$profile"
        Confirm (!(Owned-Resources $project) -and !(Docker @('image','ls','-q','--filter',"reference=$project-sut")).lines) "Fresh Compose identity $project"
        $projects.Add($project)
        $env:LAB_SECURITY_DEFECT = $profiles[$profile]
        $null = Docker @('compose','-p',$project,'build','sut')
    }

    foreach ($profile in $profiles.Keys) {
        $project = "$run-$profile"
        $folder = (New-Item -ItemType Directory -Path (Join-Path $output $profile)).FullName
        $env:LAB_SECURITY_DEFECT = $profiles[$profile]
        try {
            $null = Docker @('compose','-p',$project,'up','--no-build','--pull','never','--wait','--wait-timeout','20','sut')
            $sut = (Docker @('compose','-p',$project,'ps','-q','sut')).lines[0]
            $lab = (Docker @('network','inspect','--format','{{json .}}',"${project}_lab")).lines[0] | ConvertFrom-Json -AsHashtable
            $detail = (Docker @('inspect','--format','{"id":{{json .Id}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"health":{{json .State.Health.Status}},"image":{{json .Image}}}',$sut)).lines[0] | ConvertFrom-Json -AsHashtable
            Confirm ($lab.Internal -and $lab.Labels['com.docker.compose.project'] -ceq $project -and
                $lab.Labels['com.docker.compose.network'] -ceq 'lab' -and $lab.Containers.Count -eq 1 -and
                $detail.id -in $lab.Containers.Keys -and $detail.project -ceq $project -and $detail.health -ceq 'healthy') "Owned healthy SUT for $profile"
            $path = Join-Path $folder 'http-csp.json'
            $check = Docker @('run','--rm','--pull','never','--network',$lab.Id,'--mount',$sourceMount,$nodeImage,'node','/qel/scope.mjs','csp') -Save $path -AllowFailure
            if ($CiRun) {
                @{ nativeExit = $check.code; sut = $detail; networkId = $lab.Id } |
                    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $folder 'http-invocation.json')
            }
            $cspResults[$profile] = Evidence csp $path $check.code (Join-Path $folder 'csp-result.json')
            if ($CiRun -and $scanRequired -and $cspResults[$profile].outcome -cne 'PASS') {
                @{ reason = 'CSP baseline did not pass' } | ConvertTo-Json |
                    Set-Content -LiteralPath (Join-Path $folder 'zap-not-run.json')
            } elseif ($profile -ceq 'baseline' -and $scanRequired) {
                try {
                    Confirm ($cspResults[$profile].outcome -ceq 'PASS') 'CSP baseline qualifies before supplementary scan'
                    $ip = $lab.Containers[$detail.id].IPv4Address.Split('/')[0]
                    $zapResult = Invoke-PassiveBaseline $project $lab $ip $folder
                } catch {
                    $zapResult = @{ outcome = 'TOOL_ERROR'; diagnostic = $_.Exception.Message }
                    $zapResult | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $folder 'zap-error.json')
                    Write-Host $zapResult.diagnostic
                }
            }
        } finally {
            Remove-Profile $project
        }
    }

    $audit = Invoke-Audit 'bridge' 'npm-audit'
    if ($CiRun) {
        $after = @(Inventory | Sort-Object)
        Confirm (($before -join "`n") -ceq ($after -join "`n")) "Unrelated Compose inventory unchanged ($($after.Count) rows)"
        if ($cspResults.baseline.outcome -cin 'PASS','FAIL' -and $audit.execution -ceq 'PASS' -and
            (!$scanRequired -or $zapResult.execution -ceq 'PASS')) {
            $exitCode = if ($cspResults.baseline.outcome -ceq 'PASS' -and $audit.outcome -ceq 'PASS' -and
                (!$scanRequired -or $zapResult.outcome -ceq 'PASS')) { 0 } else { 1 }
        }
    } else {
    $offline = Invoke-Audit 'none' 'npm-offline-control'
    Confirm ($offline.outcome -ceq 'TOOL_ERROR') 'Unavailable advisory service cannot become a clean report'
    $noTarget = Docker @('run','--rm','--pull','never','--network','none',$zapImage,'zap-baseline.py') -Save (Join-Path $output 'zap-no-target.log') -AllowFailure
    Confirm ($noTarget.code -eq 3) 'ZAP without a target returns its documented execution-error code'
    $missing = Evidence zap (Join-Path $output 'absent-zap.json') $noTarget.code (Join-Path $output 'zap-missing-control.json')
    $malformed = Join-Path $output 'malformed-control.json'
    Set-Content -LiteralPath $malformed -Value '{incomplete'
    $invalidReport = Evidence zap $malformed 0 (Join-Path $output 'zap-malformed-control.json')
    Confirm ($missing.outcome -ceq 'TOOL_ERROR' -and $invalidReport.outcome -ceq 'TOOL_ERROR') 'Missing and malformed ZAP reports are rejected'
    $after = @(Inventory | Sort-Object)
    Confirm (($before -join "`n") -ceq ($after -join "`n")) "Unrelated Compose inventory unchanged ($($after.Count) rows)"

    Confirm ($cspResults.baseline.outcome -ceq 'PASS' -and $cspResults.injected.outcome -ceq 'FAIL' -and
        $cspResults.recovery.outcome -ceq 'PASS' -and
        @($cspResults.injected.observations | Where-Object { $_.contentType -like 'text/html*' -and $_.policies.Count -eq 0 }).Count -eq 5) 'Complete CSP PASS → missing-header FAIL → PASS sequence'
    foreach ($profile in $profiles.Keys) {
        $observations = $cspResults[$profile].observations
        Confirm (@($observations | Where-Object {
            $_.xContentTypeOptions.Count -eq 1 -and $_.xContentTypeOptions[0] -ceq 'nosniff'
        }).Count -eq 8) "Exact nosniff on all eight responses for $profile"
        if ($profile -cne 'baseline') {
            Confirm (!(Compare-Object $cspResults.baseline.observations $observations -Property url,status,contentType,bodySha256)) "Status, media type and body match baseline for $profile"
        }
    }
    if ($zapResult.execution -ceq 'PASS' -and $audit.execution -ceq 'PASS') {
        Confirm ('http://sut:3000/' -cin $zapResult.examined -and 'http://sut:3000/search' -cin $zapResult.examined) 'ZAP examined both routes previously affected by rule 10021'
        $exitCode = if ($zapResult.outcome -ceq 'PASS' -and $audit.outcome -ceq 'PASS') { 0 } else { 1 }
    }
    }
} catch {
    Write-Host $_.Exception.Message
} finally {
    try {
        foreach ($project in $projects.ToArray()) { Remove-Profile $project }
    } catch {
        $exitCode = 2
        Write-Host $_.Exception.Message
    } finally {
        foreach ($variable in $saved.Keys) {
            if ($null -eq $saved[$variable]) { Remove-Item -LiteralPath "Env:$variable" -ErrorAction SilentlyContinue }
            else { Set-Item -LiteralPath "Env:$variable" -Value $saved[$variable] }
        }
        Write-Host "QEL-4 wrapper exit=$exitCode. Evidence: $output"
        Stop-Transcript | Out-Null
        Pop-Location
    }
}
exit $exitCode
