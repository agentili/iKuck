[CmdletBinding()]
param(
  [string]$RepositoryRoot,
  [string]$NpmExecutable = 'npm',
  [switch]$Coverage,
  [switch]$E2E,
  [switch]$Integration
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = Split-Path -Parent $PSScriptRoot
}

$RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$frontendRoot = Join-Path $RepositoryRoot 'frontend'
$backendRoot = Join-Path $RepositoryRoot 'backend'

foreach ($projectRoot in @($frontendRoot, $backendRoot)) {
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules') -PathType Container)) {
    Write-Error "Missing node_modules in '$projectRoot'. Run npm ci in that directory before npm run verify." -ErrorAction Continue
    exit 2
  }
}

if (-not (Get-Command $NpmExecutable -ErrorAction SilentlyContinue)) {
  Write-Error "The npm executable '$NpmExecutable' is not available." -ErrorAction Continue
  exit 127
}

function Invoke-CheckedNpm {
  param(
    [string]$Name,
    [string]$WorkingDirectory,
    [string[]]$Arguments
  )

  Write-Host "==> $Name"
  Push-Location -LiteralPath $WorkingDirectory
  try {
    & $NpmExecutable @Arguments
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }

  if ($exitCode -ne 0) {
    Write-Error "Verification step '$Name' failed with exit code $exitCode." -ErrorAction Continue
    exit $exitCode
  }
}

Invoke-CheckedNpm -Name 'frontend lint' -WorkingDirectory $frontendRoot -Arguments @('run', 'lint')
Invoke-CheckedNpm -Name 'frontend unit tests' -WorkingDirectory $frontendRoot -Arguments @('test', '--', '--run')
if ($Coverage) {
  Invoke-CheckedNpm -Name 'frontend coverage' -WorkingDirectory $frontendRoot -Arguments @('run', 'test:coverage')
}
if ($E2E) {
  Invoke-CheckedNpm -Name 'frontend offline E2E' -WorkingDirectory $frontendRoot -Arguments @('run', 'test:e2e')
}
Invoke-CheckedNpm -Name 'frontend build' -WorkingDirectory $frontendRoot -Arguments @('run', 'build')

Invoke-CheckedNpm -Name 'backend lint' -WorkingDirectory $backendRoot -Arguments @('run', 'lint')
Invoke-CheckedNpm -Name 'backend unit tests' -WorkingDirectory $backendRoot -Arguments @('test')
if ($Coverage) {
  Invoke-CheckedNpm -Name 'backend coverage' -WorkingDirectory $backendRoot -Arguments @('run', 'test:coverage')
}
if ($Integration) {
  if ([string]::IsNullOrWhiteSpace($env:INTEGRATION_DATABASE_URL) -or [string]::IsNullOrWhiteSpace($env:INTEGRATION_REDIS_URL)) {
    Write-Error 'Integration verification requires INTEGRATION_DATABASE_URL and INTEGRATION_REDIS_URL.' -ErrorAction Continue
    exit 2
  }
  Invoke-CheckedNpm -Name 'backend integration tests' -WorkingDirectory $backendRoot -Arguments @('run', 'test:integration')
}
Invoke-CheckedNpm -Name 'backend build' -WorkingDirectory $backendRoot -Arguments @('run', 'build')

Write-Host 'Repository verification completed.'
