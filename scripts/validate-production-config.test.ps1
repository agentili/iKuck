$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$validatorPath = Join-Path $PSScriptRoot 'validate-production-config.ps1'
$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("ikuck-config-test-" + [guid]::NewGuid().ToString('N'))

New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null

try {
    $validConfig = @'
APP_DOMAIN=app.ikuck.it
POSTGRES_DB=ikuck
POSTGRES_USER=ikuck
POSTGRES_PASSWORD=local-safe-password-123
SESSION_SECRET=locally-generated-session-secret-with-more-than-32-characters
RESEND_API_KEY=
RESEND_FROM_EMAIL=
USDA_API_KEY=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.5
'@

    function Invoke-Validator {
        param(
            [Parameter(Mandatory = $true)][string]$Content,
            [string]$FileName = 'config.env'
        )

        $envFile = Join-Path $temporaryDirectory $FileName
        [System.IO.File]::WriteAllText($envFile, $Content.Trim() + [Environment]::NewLine)
        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $validatorPath -EnvFile $envFile 2>&1 | Out-String
        }
        finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        return [pscustomobject]@{
            ExitCode = $LASTEXITCODE
            Output = $output
        }
    }

    function Assert-Valid {
        param([string]$Name, [string]$Content, [string]$FileName = 'config.env')

        $result = Invoke-Validator -Content $Content -FileName $FileName
        if ($result.ExitCode -ne 0) {
            throw "Expected '$Name' to pass, but it failed: $($result.Output)"
        }
        Write-Host "PASS: $Name"
    }

    function Assert-Invalid {
        param([string]$Name, [string]$Content, [string]$FileName = 'config.env')

        $result = Invoke-Validator -Content $Content -FileName $FileName
        if ($result.ExitCode -eq 0) {
            throw "Expected '$Name' to fail, but it passed"
        }
        Write-Host "PASS: $Name"
    }

    Assert-Valid -Name 'valid HTTPS deployment domain' -Content $validConfig
    Assert-Invalid -Name 'missing session secret' -Content ($validConfig -replace "(?m)^SESSION_SECRET=.*\r?\n", '')
    Assert-Invalid -Name 'unchanged example database password' -Content ($validConfig -replace "(?m)^POSTGRES_PASSWORD=.*$", 'POSTGRES_PASSWORD=replace-with-a-unique-long-database-password')
    Assert-Invalid -Name 'short session secret' -Content ($validConfig -replace "(?m)^SESSION_SECRET=.*$", 'SESSION_SECRET=too-short')
    Assert-Invalid -Name 'provider key in committed sample file' -FileName '.env.example' -Content ($validConfig -replace "(?m)^RESEND_API_KEY=.*$", 'RESEND_API_KEY=re_live_provider_secret')
    Assert-Invalid -Name 'database URL outside private Compose network' -Content ($validConfig + "`nDATABASE_URL=postgres://ikuck:password@db.example.com:5432/ikuck")
    Assert-Invalid -Name 'invalid production domain' -Content ($validConfig -replace "(?m)^APP_DOMAIN=.*$", 'APP_DOMAIN=http://localhost:8080')
}
finally {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'All production configuration validation tests passed.'
