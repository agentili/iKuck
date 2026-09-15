[CmdletBinding()]
param(
    [string]$RepositoryRoot = ''
)

$ErrorActionPreference = 'Stop'

if (-not $RepositoryRoot) {
    $RepositoryRoot = Split-Path -Parent $PSScriptRoot
}

function Assert-Condition {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw "Container hardening assertion failed: $Message"
    }
}

$dockerfile = Get-Content -Raw -LiteralPath (Join-Path $RepositoryRoot 'backend/Dockerfile')
Assert-Condition ($dockerfile -match '(?m)^USER ikuck$') 'The API runtime image must declare the non-root ikuck user.'

foreach ($composeName in @('deploy/docker-compose.standalone.yml', 'deploy/docker-compose.production.yml')) {
    $composePath = Join-Path $RepositoryRoot $composeName
    $compose = Get-Content -Raw -LiteralPath $composePath
    Assert-Condition ($compose -match '(?ms)api:.*?read_only:\s*true') "$composeName must make the API filesystem read-only."
    Assert-Condition ($compose -match '(?ms)api:.*?cap_drop:\s*\n\s*-\s*ALL') "$composeName must drop all API capabilities."
    Assert-Condition ($compose -match '(?ms)api:.*?tmpfs:\s*\n\s*-\s*/tmp') "$composeName must provide a writable /tmp tmpfs."
    Assert-Condition ($compose -notmatch '(?m)^\s*-\s*"?(?:0\.0\.0\.0:)?5432:') "$composeName must not publish PostgreSQL."
    Assert-Condition ($compose -notmatch '(?m)^\s*-\s*"?(?:0\.0\.0\.0:)?6379:') "$composeName must not publish Redis."
}

Write-Output 'container-hardening.test.ps1 passed'
