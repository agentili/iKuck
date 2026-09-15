[CmdletBinding()]
param(
    [string]$BaseUrl = '',
    [string]$CaddyfilePath = ''
)

$ErrorActionPreference = 'Stop'

if (-not $BaseUrl) {
    $BaseUrl = if ($env:IKUCK_BASE_URL) { $env:IKUCK_BASE_URL } else { 'http://127.0.0.1:8080' }
}
if (-not $CaddyfilePath) {
    $CaddyfilePath = Join-Path $PSScriptRoot 'Caddyfile'
}

function Assert-Condition {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw "Security header assertion failed: $Message"
    }
}

$caddyfile = Get-Content -Raw -LiteralPath $CaddyfilePath
Assert-Condition ($caddyfile -match 'Content-Security-Policy') 'Caddyfile must define Content-Security-Policy.'
Assert-Condition ($caddyfile -notmatch 'unsafe-eval') 'CSP must not allow unsafe-eval.'
Assert-Condition ($caddyfile -match 'X-Content-Type-Options') 'Caddyfile must define X-Content-Type-Options.'
Assert-Condition ($caddyfile -match 'X-Frame-Options') 'Caddyfile must define a frame policy.'
Assert-Condition ($caddyfile -match 'Referrer-Policy') 'Caddyfile must define Referrer-Policy.'
Assert-Condition ($caddyfile -match 'Permissions-Policy') 'Caddyfile must define Permissions-Policy.'
Assert-Condition ($caddyfile -match 'Strict-Transport-Security') 'Caddyfile must define conditional HSTS.'

$response = Invoke-WebRequest -UseBasicParsing -Uri $BaseUrl
$headers = $response.Headers
Assert-Condition ($headers['Content-Security-Policy'] -and $headers['Content-Security-Policy'] -notmatch 'unsafe-eval') 'Live response must expose CSP without unsafe-eval.'
Assert-Condition ($headers['X-Content-Type-Options'] -eq 'nosniff') 'Live response must expose nosniff.'
Assert-Condition ($headers['X-Frame-Options'] -eq 'DENY') 'Live response must deny framing.'
Assert-Condition ($headers['Referrer-Policy'] -eq 'strict-origin-when-cross-origin') 'Live response must expose the documented referrer policy.'
Assert-Condition ($headers['Permissions-Policy']) 'Live response must expose Permissions-Policy.'

if ($BaseUrl -match '^https://') {
    Assert-Condition ($headers['Strict-Transport-Security']) 'HTTPS response must expose HSTS.'
} else {
    Assert-Condition (-not $headers['Strict-Transport-Security']) 'HTTP response must not expose HSTS.'
}

Write-Output "security-headers.test.ps1 passed for $BaseUrl"
