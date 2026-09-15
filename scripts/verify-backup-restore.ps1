[CmdletBinding()]
param(
    [string]$RepositoryRoot = '',
    [switch]$KeepArtifacts
)

$ErrorActionPreference = 'Stop'

if (-not $RepositoryRoot) {
    $RepositoryRoot = Split-Path -Parent $PSScriptRoot
}

$composeFile = Join-Path $RepositoryRoot 'deploy/docker-compose.integration.yml'
$projectName = "ikuck-recovery-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$artifactRoot = Join-Path ([IO.Path]::GetTempPath()) $projectName
$backupDirectory = Join-Path $artifactRoot 'backups'
$postgresPort = 55440 + (Get-Random -Minimum 0 -Maximum 40)
$redisPort = 56380 + (Get-Random -Minimum 0 -Maximum 40)
$bashExe = if (Test-Path 'C:\Program Files\Git\bin\bash.exe') {
    'C:\Program Files\Git\bin\bash.exe'
} else {
    (Get-Command bash -ErrorAction Stop).Source
}
$composeStarted = $false

New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null

function Convert-ToBashPath {
    param([string]$Path)

    $escapedPath = $Path.Replace("'", "'\\''")
    $converted = & $bashExe -lc "cygpath -u '$escapedPath'"
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to convert path to the shell format: $Path"
    }
    return ($converted | Out-String).Trim()
}

function Invoke-Compose {
    param()

    & docker compose -p $projectName -f $composeFile @args
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose failed with exit code ${LASTEXITCODE}: $($args -join ' ')"
    }
}

function Invoke-BashScript {
    param(
        [string]$ScriptPath,
        [hashtable]$Environment,
        [string]$Arguments = ''
    )

    $scriptUnix = Convert-ToBashPath $ScriptPath
    $assignments = foreach ($entry in $Environment.GetEnumerator()) {
        $value = ([string]$entry.Value).Replace("'", "'\\''")
        "$($entry.Key)='$value'"
    }
    $argumentSuffix = if ($Arguments) { " $Arguments" } else { '' }
    $command = "$($assignments -join ' ') sh '$scriptUnix'$argumentSuffix"
    & $bashExe -lc $command
    if ($LASTEXITCODE -ne 0) {
        throw "Shell script failed with exit code ${LASTEXITCODE}: $ScriptPath"
    }
}

function Get-FixtureFingerprint {
    $query = "SELECT count(*)::text || '|' || coalesce(string_agg(fixture_key || '=' || fixture_value, '|' ORDER BY fixture_key), '') FROM recovery_fixture;"
    $raw = & docker compose -p $projectName -f $composeFile exec -T postgres psql -U integration -d ikuck_integration -Atqc $query
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to read the disposable recovery fixture.'
    }
    $canonical = ($raw | Out-String).Trim()
    $separator = $canonical.IndexOf('|')
    if ($separator -lt 0) {
        throw 'The disposable recovery fixture returned an invalid fingerprint.'
    }
    $count = [int]$canonical.Substring(0, $separator)
    $payload = $canonical.Substring($separator + 1)
    $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha256.ComputeHash($bytes)
    } finally {
        $sha256.Dispose()
    }
    $hash = [BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant()
    return [pscustomobject]@{ Count = $count; Hash = $hash }
}

try {
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $composeUnix = Convert-ToBashPath $composeFile
    $backupUnix = Convert-ToBashPath $backupDirectory
    $backupScript = Join-Path $RepositoryRoot 'deploy/backup-postgres.sh'
    $restoreScript = Join-Path $RepositoryRoot 'deploy/restore-postgres.sh'

    $env:INTEGRATION_POSTGRES_PORT = [string]$postgresPort
    $env:INTEGRATION_REDIS_PORT = [string]$redisPort
    Invoke-Compose up -d
    $composeStarted = $true

    for ($attempt = 1; $attempt -le 30; $attempt++) {
        & docker compose -p $projectName -f $composeFile exec -T postgres pg_isready -U integration -d ikuck_integration *> $null
        if ($LASTEXITCODE -eq 0) {
            break
        }
        if ($attempt -eq 30) {
            throw 'Disposable PostgreSQL did not become ready.'
        }
        Start-Sleep -Seconds 2
    }

    $fixtureSql = @'
CREATE TABLE recovery_fixture (fixture_key text PRIMARY KEY, fixture_value text NOT NULL);
INSERT INTO recovery_fixture (fixture_key, fixture_value) VALUES
  ('fixture-a', 'value-a'),
  ('fixture-b', 'value-b'),
  ('fixture-c', 'value-c');
'@
    Invoke-Compose exec -T postgres psql -v ON_ERROR_STOP=1 -U integration -d ikuck_integration -c $fixtureSql
    $before = Get-FixtureFingerprint

    Invoke-BashScript -ScriptPath $backupScript -Environment @{
        COMPOSE_PROJECT_NAME = $projectName
        COMPOSE_FILE = $composeUnix
        POSTGRES_DB = 'ikuck_integration'
        POSTGRES_USER = 'integration'
        BACKUP_DIR = $backupUnix
        BACKUP_RETENTION_COUNT = '5'
    }
    $archive = Get-ChildItem -LiteralPath $backupDirectory -Filter '*.dump' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $archive) {
        throw 'The backup rehearsal did not create an archive.'
    }
    $checksum = Get-Item -LiteralPath "$($archive.FullName).sha256"

    Invoke-Compose down -v --remove-orphans
    $composeStarted = $false
    Invoke-Compose up -d
    $composeStarted = $true
    for ($attempt = 1; $attempt -le 30; $attempt++) {
        & docker compose -p $projectName -f $composeFile exec -T postgres pg_isready -U integration -d ikuck_integration *> $null
        if ($LASTEXITCODE -eq 0) {
            break
        }
        if ($attempt -eq 30) {
            throw 'Disposable PostgreSQL did not become ready after recreation.'
        }
        Start-Sleep -Seconds 2
    }

    $restoreTarget = "ikuck_integration@$projectName"
    $restoreEnvironment = @{
        COMPOSE_PROJECT_NAME = $projectName
        ARCHIVE_PATH = (Convert-ToBashPath $archive.FullName)
        ARCHIVE_CHECKSUM_PATH = (Convert-ToBashPath $checksum.FullName)
        COMPOSE_FILE = $composeUnix
        POSTGRES_DB = 'ikuck_integration'
        POSTGRES_USER = 'integration'
        RESTORE_TARGET = $restoreTarget
        RESTORE_CONFIRM = "RESTORE $restoreTarget"
        BACKUP_DIR = $backupUnix
        API_SERVICE = 'none'
    }
    Invoke-BashScript -ScriptPath $restoreScript -Environment $restoreEnvironment -Arguments '--dry-run'
    Invoke-BashScript -ScriptPath $restoreScript -Environment $restoreEnvironment
    $after = Get-FixtureFingerprint

    if ($before.Count -ne $after.Count -or $before.Hash -ne $after.Hash) {
        throw "Recovery fixture mismatch: before count/hash $($before.Count)/$($before.Hash), after $($after.Count)/$($after.Hash)."
    }

    $stopwatch.Stop()
    Write-Output "Backup and restore rehearsal passed: count=$($after.Count), hash=$($after.Hash), archiveBytes=$($archive.Length), durationSeconds=$([math]::Round($stopwatch.Elapsed.TotalSeconds, 1))."
} finally {
    if ($composeStarted -and -not $KeepArtifacts) {
        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = 'SilentlyContinue'
        & docker compose -p $projectName -f $composeFile down -v --remove-orphans 2> $null | Out-Null
        $cleanupExitCode = $LASTEXITCODE
        $ErrorActionPreference = $previousErrorActionPreference
        if ($cleanupExitCode -ne 0) {
            Write-Warning "Disposable cleanup failed; remove project $projectName manually."
        }
    }
    Remove-Item Env:INTEGRATION_POSTGRES_PORT -ErrorAction SilentlyContinue
    Remove-Item Env:INTEGRATION_REDIS_PORT -ErrorAction SilentlyContinue
    if (-not $KeepArtifacts) {
        Remove-Item -LiteralPath $artifactRoot -Recurse -Force -ErrorAction SilentlyContinue
    } else {
        Write-Output "Recovery artifacts kept at $artifactRoot."
    }
}
