[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$verifyScript = Join-Path $PSScriptRoot 'verify-repository.ps1'
$shellCommand = Get-Command pwsh -ErrorAction SilentlyContinue
if ($null -eq $shellCommand) {
  $shellCommand = Get-Command powershell -ErrorAction Stop
}
$shellExecutable = $shellCommand.Source
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ikuck-verify-$([guid]::NewGuid().ToString('N'))"

function New-TestProject {
  param([bool]$WithNodeModules)

  New-Item -ItemType Directory -Path (Join-Path $temporaryRoot 'frontend') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $temporaryRoot 'backend') -Force | Out-Null
  if ($WithNodeModules) {
    New-Item -ItemType Directory -Path (Join-Path $temporaryRoot 'frontend/node_modules') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $temporaryRoot 'backend/node_modules') -Force | Out-Null
  }
}

function Invoke-VerifySubprocess {
  param([string[]]$Arguments)

  $stdoutPath = Join-Path $temporaryRoot "stdout-$([guid]::NewGuid().ToString('N')).txt"
  $stderrPath = Join-Path $temporaryRoot "stderr-$([guid]::NewGuid().ToString('N')).txt"
  $process = Start-Process -FilePath $shellExecutable -ArgumentList $Arguments -Wait -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  $output = "$(Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue)$(Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue)"
  Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
  return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $output }
}

try {
  New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
  New-TestProject -WithNodeModules:$false
  $missingResult = Invoke-VerifySubprocess -Arguments @('-NoProfile', '-File', $verifyScript, '-RepositoryRoot', $temporaryRoot)
  if ($missingResult.ExitCode -eq 0 -or $missingResult.Output -notmatch 'Missing node_modules') {
    throw 'The verifier did not report the missing node_modules preflight failure.'
  }

  Remove-Item -LiteralPath $temporaryRoot -Force -Recurse
  New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
  New-TestProject -WithNodeModules:$true
  $fakeNpmName = if ($IsWindows) { 'fake-npm.cmd' } else { 'fake-npm' }
  $fakeNpm = Join-Path $temporaryRoot $fakeNpmName
  if ($IsWindows) {
    Set-Content -LiteralPath $fakeNpm -Value "@echo off`r`nexit /b 17`r`n" -NoNewline
  } else {
    Set-Content -LiteralPath $fakeNpm -Value "#!/bin/sh`nexit 17`n" -NoNewline
    & chmod +x $fakeNpm
  }
  $failureResult = Invoke-VerifySubprocess -Arguments @('-NoProfile', '-File', $verifyScript, '-RepositoryRoot', $temporaryRoot, '-NpmExecutable', $fakeNpm)
  if ($failureResult.ExitCode -ne 17 -or $failureResult.Output -notmatch 'frontend lint') {
    throw "The verifier did not propagate the npm exit code. Output: $($failureResult.Output)"
  }

  Write-Host 'verify-repository.test.ps1 passed.'
  exit 0
} finally {
  if (Test-Path -LiteralPath $temporaryRoot) {
    Remove-Item -LiteralPath $temporaryRoot -Force -Recurse
  }
}
