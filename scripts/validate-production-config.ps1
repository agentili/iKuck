[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$EnvFile
)

$ErrorActionPreference = 'Stop'
$script:ValidationErrors = New-Object 'System.Collections.Generic.List[string]'

function Add-ValidationError {
    param([string]$Message)

    [void]$script:ValidationErrors.Add($Message)
}

function Test-PlaceholderValue {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return $true }
    return $Value -match '(?i)replace-with|change[-_]?me|your[-_]?value|<[^>]+>|example\.com|\.example$'
}

function Read-EnvironmentFile {
    param([string]$Path)

    $values = @{}
    $lineNumber = 0
    foreach ($rawLine in Get-Content -LiteralPath $Path) {
        $lineNumber++
        $line = $rawLine.Trim()
        if ($line.Length -eq 0 -or $line.StartsWith('#')) { continue }

        if ($line -notmatch '^(?<key>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>.*)$') {
            Add-ValidationError "Line $lineNumber is not a valid KEY=VALUE assignment"
            continue
        }

        $key = $Matches['key']
        $value = $Matches['value'].Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $values[$key] = $value
    }

    return $values
}

function Get-Value {
    param(
        [hashtable]$Values,
        [string]$Name
    )

    if ($Values.ContainsKey($Name)) { return [string]$Values[$Name] }
    return $null
}

function Require-ProductionValue {
    param(
        [hashtable]$Values,
        [string]$Name
    )

    $value = Get-Value -Values $Values -Name $Name
    if (Test-PlaceholderValue -Value $value) {
        Add-ValidationError "$Name is missing or still contains a placeholder"
    }
    return $value
}

function Test-ProductionDomain {
    param([string]$Domain)

    if ([string]::IsNullOrWhiteSpace($Domain)) {
        Add-ValidationError 'APP_DOMAIN is missing'
        return
    }
    if ($Domain -match '(?i)^(https?://|localhost|127\.0\.0\.1$)' -or $Domain -match '[/ :@]') {
        Add-ValidationError 'APP_DOMAIN must be a hostname without scheme, port, path or localhost'
        return
    }
    if ($Domain.Length -gt 253 -or $Domain.Split('.').Count -lt 2) {
        Add-ValidationError 'APP_DOMAIN must be a fully qualified domain name'
        return
    }
    foreach ($label in $Domain.Split('.')) {
        if ($label.Length -gt 63 -or $label -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$') {
            Add-ValidationError 'APP_DOMAIN contains an invalid hostname label'
            return
        }
    }
    if ($Domain.Split('.')[-1].Length -lt 2) {
        Add-ValidationError 'APP_DOMAIN must end with a valid top-level domain'
    }
}

function Test-PrivateServiceUrl {
    param(
        [hashtable]$Values,
        [string]$Name,
        [string]$ExpectedHost,
        [string[]]$AllowedSchemes
    )

    $value = Get-Value -Values $Values -Name $Name
    if ([string]::IsNullOrWhiteSpace($value)) { return }

    try {
        $uri = [System.Uri]::new($value)
    }
    catch {
        Add-ValidationError "$Name is not a valid service URL"
        return
    }

    if ($AllowedSchemes -notcontains $uri.Scheme -or $uri.Host -ne $ExpectedHost) {
        Add-ValidationError "$Name must use an internal Compose host named '$ExpectedHost'"
    }
}

if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
    Write-Error "Environment file not found: $EnvFile"
    exit 1
}

$resolvedEnvFile = (Resolve-Path -LiteralPath $EnvFile).Path
$values = Read-EnvironmentFile -Path $resolvedEnvFile

$null = Require-ProductionValue -Values $values -Name 'APP_DOMAIN'
$null = Require-ProductionValue -Values $values -Name 'POSTGRES_DB'
$null = Require-ProductionValue -Values $values -Name 'POSTGRES_USER'
$postgresPassword = Require-ProductionValue -Values $values -Name 'POSTGRES_PASSWORD'

Test-ProductionDomain -Domain (Get-Value -Values $values -Name 'APP_DOMAIN')

if ($null -ne $postgresPassword -and $postgresPassword -match '[@:/?#]') {
    Add-ValidationError 'POSTGRES_PASSWORD contains URL-reserved characters and cannot be embedded safely in DATABASE_URL'
}

$sampleFile = [System.IO.Path]::GetFileName($resolvedEnvFile) -match '(?i)\.example$|\.sample$'
foreach ($providerSecretName in @('RESEND_API_KEY', 'USDA_API_KEY', 'OPENAI_API_KEY')) {
    $providerSecret = Get-Value -Values $values -Name $providerSecretName
    if ($sampleFile -and -not [string]::IsNullOrWhiteSpace($providerSecret)) {
        Add-ValidationError "$providerSecretName must be empty in a committed sample file"
    }
}

$resendKey = Get-Value -Values $values -Name 'RESEND_API_KEY'
$resendFromEmail = Get-Value -Values $values -Name 'RESEND_FROM_EMAIL'
$legacyResendFrom = Get-Value -Values $values -Name 'RESEND_FROM'
if (-not [string]::IsNullOrWhiteSpace($resendKey) -and [string]::IsNullOrWhiteSpace($resendFromEmail) -and [string]::IsNullOrWhiteSpace($legacyResendFrom)) {
    Add-ValidationError 'RESEND_API_KEY requires RESEND_FROM_EMAIL (or legacy RESEND_FROM)'
}
if (-not [string]::IsNullOrWhiteSpace($resendFromEmail) -and $resendFromEmail -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') {
    Add-ValidationError 'RESEND_FROM_EMAIL must be a valid sender address'
}
if (-not [string]::IsNullOrWhiteSpace($legacyResendFrom) -and $legacyResendFrom -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') {
    Add-ValidationError 'RESEND_FROM must be a valid sender address'
}

Test-PrivateServiceUrl -Values $values -Name 'DATABASE_URL' -ExpectedHost 'postgres' -AllowedSchemes @('postgres', 'postgresql')
Test-PrivateServiceUrl -Values $values -Name 'REDIS_URL' -ExpectedHost 'redis' -AllowedSchemes @('redis', 'rediss')

if ($script:ValidationErrors.Count -gt 0) {
    foreach ($validationError in $script:ValidationErrors) {
        Write-Error "Production configuration invalid: $validationError"
    }
    exit 1
}

Write-Output "Production configuration valid: $resolvedEnvFile"
exit 0
