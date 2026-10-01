#Requires -Version 5.1
<#
.SYNOPSIS
  ConnectUs / Grade Tracker - dual Firebase environment setup.

  Production : school-grade-tracker      (branch: main)
  Development: dev-school-grade-tracker  (branch: dev)

.DESCRIPTION
  1. Verifies firebase, gh, gcloud, git, node are installed and authenticated.
  2. Writes .firebaserc aliases (default/dev -> dev-school-grade-tracker, prod -> school-grade-tracker).
  3. Creates .env.development / .env.production from template if absent, fills client keys from
     the live web SDK config (server keys untouched)
     and regenerates assets/js/firebase-config.js.
  4. Exports LIVE prod Firestore rules + indexes + Auth sign-in config and deploys them to dev.
  5. Commits the environment files on main, creates dev from main, pushes both upstream.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-environments.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-environments.ps1 -SkipGit
#>
[CmdletBinding()]
param(
    [switch]$SkipParity,
    [switch]$SkipGit,
    [string]$RepoSlug          = 'mystorebz/grade-tracker',
    [string]$FirestoreLocation = 'nam5',
    [string]$ProdWebAppId      = '1:326406075140:web:cff69a1ea0c20a66b21651',
    [string]$DevWebAppName     = 'ConnectUs Dev'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PROD = 'school-grade-tracker'
$DEV  = 'dev-school-grade-tracker'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Snapshot = Join-Path $Root 'env-sync\prod-snapshot'
$Utf8     = New-Object System.Text.UTF8Encoding($false)

# -- helpers ----------------------------------------------------------------
function Step([string]$m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok([string]$m)   { Write-Host "    OK  $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "    !!  $m" -ForegroundColor Yellow }
function Fail([string]$m) { Write-Host "`nERROR: $m" -ForegroundColor Red; exit 1 }

function Write-Utf8([string]$Path, [string]$Text) {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($Path, $Text, $Utf8)
}

function Assert-Cli([string]$Name, [string]$Hint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { Fail "'$Name' not found on PATH. $Hint" }
}

# Native call; returns stdout text, fails on non-zero exit. (Local 'Continue' avoids
# Windows PowerShell 5.1 turning native stderr into terminating errors.)
function Invoke-Native {
    param([Parameter(Mandatory)][string]$Exe, [Parameter(ValueFromRemainingArguments)][string[]]$Rest)
    $ErrorActionPreference = 'Continue'
    $out = & $Exe @Rest 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { Fail "$Exe $($Rest -join ' ') (exit $LASTEXITCODE)`n$out" }
    return $out
}

# Native call that may legitimately fail; returns $true/$false.
function Test-Native {
    param([Parameter(Mandatory)][string]$Exe, [Parameter(ValueFromRemainingArguments)][string[]]$Rest)
    $ErrorActionPreference = 'Continue'
    & $Exe @Rest *> $null
    return ($LASTEXITCODE -eq 0)
}

# firebase <args> --json -> parsed object (fails unless status == success)
function Invoke-FirebaseJson {
    param([Parameter(ValueFromRemainingArguments)][string[]]$Rest)
    $ErrorActionPreference = 'Continue'
    $raw = & firebase @Rest --json 2>$null | Out-String
    try { $obj = $raw | ConvertFrom-Json } catch { Fail "firebase $($Rest -join ' ') returned non-JSON:`n$raw" }
    if ($obj.status -ne 'success') { Fail "firebase $($Rest -join ' ') failed: $($obj | ConvertTo-Json -Depth 10 -Compress)" }
    return $obj
}

function Get-GcpToken {
    $ErrorActionPreference = 'Continue'
    $t = (& gcloud auth print-access-token 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $t) { Fail "gcloud is not authenticated. Run: gcloud auth login" }
    return $t
}

function Invoke-GApi([string]$Method, [string]$Uri, [string]$QuotaProject, $Body = $null) {
    $p = @{
        Method      = $Method
        Uri         = $Uri
        Headers     = @{ Authorization = "Bearer $script:Token"; 'x-goog-user-project' = $QuotaProject }
        ContentType = 'application/json; charset=utf-8'
    }
    if ($null -ne $Body) { $p.Body = [System.Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 30)) }
    return Invoke-RestMethod @p
}

function Has-Prop($Obj, [string]$Name) { return ($null -ne $Obj) -and ($null -ne $Obj.PSObject.Properties[$Name]) }

# Replace/append KEY=VALUE lines in an env file without touching any other line.
function Set-EnvValues([string]$Path, [hashtable]$Values) {
    if (-not (Test-Path $Path)) { Fail "$Path is missing. Restore it from the repo templates first." }
    $seen = @{}
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($line -match '^\s*([A-Z0-9_]+)\s*=' -and $Values.ContainsKey($Matches[1])) {
            $k = $Matches[1]; $seen[$k] = $true; $out.Add("$k=$($Values[$k])")
        } else { $out.Add($line) }
    }
    foreach ($k in $Values.Keys) { if (-not $seen.ContainsKey($k)) { $out.Add("$k=$($Values[$k])") } }
    Write-Utf8 $Path (($out -join "`n") + "`n")
}

# Creates .env.<mode> from the standard template when absent (never overwrites).
function New-EnvFileIfMissing([string]$Path, [string]$Mode, [string]$ProjectId, [string]$Branch, [string]$Hosts, [string]$Alias) {
    if (Test-Path $Path) { return }
    Write-Utf8 $Path @"
# -- ConnectUs / Grade Tracker - $($Mode.ToUpper()) ----------------------------------
# Firebase project: $ProjectId   |   Git branch: $Branch
# GITIGNORED - never commit. NEXT_PUBLIC_FIREBASE_* values are (re)filled by
# scripts/setup-environments.ps1 from 'firebase apps:sdkconfig'.

# -- Client (public web SDK config -> assets/js/firebase-config.js) ---------
NEXT_PUBLIC_APP_ENV=$Mode
NEXT_PUBLIC_APP_HOSTNAMES=$Hosts
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$ProjectId.firebaseapp.com
NEXT_PUBLIC_FIREBASE_DATABASE_URL=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=$ProjectId
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=

# -- Server / Admin SDK (local Node scripts only - never shipped) -----------
# Key file lives OUTSIDE the repo. Console -> Project settings ->
# Service accounts -> Generate new private key.
FIREBASE_PROJECT_ID=$ProjectId
GOOGLE_APPLICATION_CREDENTIALS=C:\Users\admin\.secrets\$ProjectId-sa.json
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=

# -- Cloud Functions secrets: Secret Manager only, never in this file -------
#   firebase functions:secrets:set GMAIL_APP_PASSWORD --project $Alias
"@
    Ok "created $(Split-Path -Leaf $Path) from template"
}

function Get-WebSdkConfig([string]$Project, [string]$PreferredAppId, [string]$CreateName) {
    $apps = @((Invoke-FirebaseJson apps:list WEB --project $Project).result)
    $app = $null
    if ($PreferredAppId) { $app = $apps | Where-Object { $_.appId -eq $PreferredAppId } | Select-Object -First 1 }
    if (-not $app) { $app = $apps | Select-Object -First 1 }
    if (-not $app) {
        if (-not $CreateName) { Fail "No web app registered in $Project." }
        $app = (Invoke-FirebaseJson apps:create WEB $CreateName --project $Project).result
        Ok "Registered web app '$CreateName' in $Project"
    }
    $r = (Invoke-FirebaseJson apps:sdkconfig WEB $app.appId --project $Project).result
    if (Has-Prop $r 'sdkConfig')    { return $r.sdkConfig }
    if (Has-Prop $r 'fileContents') { return ([regex]::Match($r.fileContents, '\{[\s\S]*\}').Value | ConvertFrom-Json) }
    return $r
}

function To-EnvMap($Cfg) {
    $map = [ordered]@{
        NEXT_PUBLIC_FIREBASE_API_KEY             = 'apiKey'
        NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN         = 'authDomain'
        NEXT_PUBLIC_FIREBASE_DATABASE_URL        = 'databaseURL'
        NEXT_PUBLIC_FIREBASE_PROJECT_ID          = 'projectId'
        NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET      = 'storageBucket'
        NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID = 'messagingSenderId'
        NEXT_PUBLIC_FIREBASE_APP_ID              = 'appId'
        NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID      = 'measurementId'
    }
    $vals = @{}
    foreach ($k in $map.Keys) { $vals[$k] = $(if (Has-Prop $Cfg $map[$k]) { [string]$Cfg.($map[$k]) } else { '' }) }
    return $vals
}

# -- 1. CLI presence + authentication ---------------------------------------
Step 'Verifying CLIs and authentication'
Assert-Cli git      'Install Git for Windows.'
Assert-Cli node     'Install Node.js 20+.'
Assert-Cli firebase 'npm install -g firebase-tools'
Assert-Cli gh       'winget install GitHub.cli'
if (-not $SkipParity) { Assert-Cli gcloud 'Install the Google Cloud CLI (needed to read live prod rules/auth config).' }

$fbUsers = @((Invoke-FirebaseJson login:list).result)
if ($fbUsers.Count -eq 0) { Fail 'Firebase CLI not logged in. Run: firebase login' }
Ok "firebase: $(($fbUsers | ForEach-Object { if (Has-Prop $_ 'user') { $_.user.email } else { $_ } }) -join ', ')"

$visible = @((Invoke-FirebaseJson projects:list).result | ForEach-Object { $_.projectId })
foreach ($p in @($PROD, $DEV)) { if ($visible -notcontains $p) { Fail "Firebase account cannot see project '$p'." } }
Ok "projects visible: $PROD, $DEV"

if (-not (Test-Native gh auth status)) { Fail 'GitHub CLI not logged in. Run: gh auth login' }
$null = Invoke-Native gh repo view $RepoSlug --json nameWithOwner
Ok "gh: access to $RepoSlug"

if (-not $SkipParity) { $script:Token = Get-GcpToken; Ok 'gcloud: access token issued' }

# -- 2. Firebase aliases ----------------------------------------------------
Step 'Writing .firebaserc aliases'
Write-Utf8 (Join-Path $Root '.firebaserc') @"
{
  "projects": {
    "default": "$DEV",
    "dev": "$DEV",
    "prod": "$PROD"
  }
}
"@
$null = Invoke-Native firebase use dev
Ok "default -> $DEV | dev -> $DEV | prod -> $PROD (active: dev)"

# -- 3. Client SDK config -> env files -> assets/js/firebase-config.js ------
Step 'Syncing web SDK config into .env.production / .env.development'
New-EnvFileIfMissing (Join-Path $Root '.env.production')  'production'  $PROD 'main' "connectusonline.org,www.connectusonline.org,$PROD.web.app,$PROD.firebaseapp.com" 'prod'
New-EnvFileIfMissing (Join-Path $Root '.env.development') 'development' $DEV  'dev'  "$DEV.web.app,$DEV.firebaseapp.com" 'dev'
Set-EnvValues (Join-Path $Root '.env.production')  (To-EnvMap (Get-WebSdkConfig $PROD $ProdWebAppId ''))
Set-EnvValues (Join-Path $Root '.env.development') (To-EnvMap (Get-WebSdkConfig $DEV  ''            $DevWebAppName))
$null = Invoke-Native node scripts/generate-firebase-config.mjs
Ok 'assets/js/firebase-config.js regenerated'

# -- 4. Prod -> dev parity (Firestore rules, indexes, Auth sign-in config) --
if (-not $SkipParity) {
    Step "Ensuring Firestore (default) exists in $DEV"
    $dbNames = @((Invoke-FirebaseJson firestore:databases:list --project $DEV).result |
        ForEach-Object { if ($_ -is [string]) { $_ } else { $_.name } })
    if (-not ($dbNames | Where-Object { $_ -match '/databases/\(default\)$' })) {
        $null = Invoke-Native firebase firestore:databases:create '(default)' --location $FirestoreLocation --project $DEV
        Ok "created (default) in $FirestoreLocation"
    } else { Ok '(default) present' }

    Step "Exporting LIVE Firestore rules + indexes from $PROD"
    if (Test-Path $Snapshot) { Remove-Item $Snapshot -Recurse -Force }
    New-Item -ItemType Directory -Path $Snapshot -Force | Out-Null

    $release = Invoke-GApi GET "https://firebaserules.googleapis.com/v1/projects/$PROD/releases/cloud.firestore" $PROD
    $ruleset = Invoke-GApi GET "https://firebaserules.googleapis.com/v1/$($release.rulesetName)" $PROD
    $rulesSrc = @($ruleset.source.files)[0].content
    if (-not $rulesSrc) { Fail 'Live prod ruleset is empty.' }
    Write-Utf8 (Join-Path $Snapshot 'firestore.rules') $rulesSrc
    Ok "rules: $($release.rulesetName)"

    $idxRaw = Invoke-Native firebase firestore:indexes --project $PROD
    $idxJson = [regex]::Match($idxRaw, '\{[\s\S]*\}').Value
    try { $null = $idxJson | ConvertFrom-Json } catch { Fail "Could not parse prod index export:`n$idxRaw" }
    Write-Utf8 (Join-Path $Snapshot 'firestore.indexes.json') $idxJson
    Ok 'indexes exported'

    $localRules = [System.IO.File]::ReadAllText((Join-Path $Root 'firestore.rules'))
    if (($localRules -replace "`r", '').Trim() -ne ($rulesSrc -replace "`r", '').Trim()) {
        Warn 'Live prod rules differ from repo firestore.rules - dev will mirror LIVE prod. Diff: env-sync/prod-snapshot/firestore.rules'
    }

    Write-Utf8 (Join-Path $Snapshot 'firebase.json') @'
{
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  }
}
'@

    Step "Deploying prod rules + indexes to $DEV"
    $null = Invoke-Native firebase deploy --only 'firestore:rules,firestore:indexes' --project $DEV --config (Join-Path $Snapshot 'firebase.json') --non-interactive --force
    Ok 'Firestore parity deployed'

    Step "Copying Auth sign-in configuration $PROD -> $DEV"
    $prodAuth = Invoke-GApi GET "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROD/config" $PROD
    $devAuthReady = $true
    try { $null = Invoke-GApi GET "https://identitytoolkit.googleapis.com/admin/v2/projects/$DEV/config" $DEV }
    catch { $devAuthReady = $false }

    if (-not $devAuthReady) {
        Warn "Authentication not initialized on $DEV. Click 'Get started': https://console.firebase.google.com/project/$DEV/authentication - then re-run."
    } elseif (Has-Prop $prodAuth 'signIn') {
        $signIn = @{}; $mask = @()
        foreach ($k in @('email', 'phoneNumber', 'anonymous', 'allowDuplicateEmails')) {
            if (Has-Prop $prodAuth.signIn $k) { $signIn[$k] = $prodAuth.signIn.$k; $mask += "signIn.$k" }
        }
        Write-Utf8 (Join-Path $Snapshot 'auth-signin.json') (@{ signIn = $signIn } | ConvertTo-Json -Depth 30)
        if ($mask.Count) {
            $null = Invoke-GApi PATCH "https://identitytoolkit.googleapis.com/admin/v2/projects/$DEV/config?updateMask=$($mask -join ',')" $DEV @{ signIn = $signIn }
            Ok "auth sign-in providers copied ($($mask -join ', '))"
        } else { Ok 'prod has no sign-in providers to copy (custom-token auth only)' }
    }
}

# -- 5. Git branches --------------------------------------------------------
if (-not $SkipGit) {
    Step 'Configuring Git branches main + dev'
    if (-not (Test-Native git rev-parse --is-inside-work-tree)) { Fail "$Root is not a Git repository." }

    $originUrl = "https://github.com/$RepoSlug.git"
    if (Test-Native git remote get-url origin) { Ok "origin: $((Invoke-Native git remote get-url origin).Trim())" }
    else { $null = Invoke-Native git remote add origin $originUrl; Ok "origin added: $originUrl" }

    foreach ($envFile in @('.env.development', '.env.production')) {
        if ((Invoke-Native git ls-files -- $envFile).Trim()) {
            $null = Invoke-Native git rm --cached --quiet -- $envFile
            Warn "$envFile was tracked - removed from index (file kept on disk)"
        }
    }

    $null = Invoke-Native git fetch origin --prune
    $current = (Invoke-Native git rev-parse --abbrev-ref HEAD).Trim()
    if ($current -ne 'main') { $null = Invoke-Native git checkout main }
    $null = Invoke-Native git pull --ff-only origin main

    $envPaths = @(
        '.firebaserc', 'firebase.json', 'package.json', '.gitignore',
        'assets/js/firebase-config.js', 'assets/js/firebase-init.js',
        'scripts/setup-environments.ps1', 'scripts/generate-firebase-config.mjs', 'scripts/assert-branch.mjs'
    )
    $null = Invoke-Native git add -- @envPaths
    if (-not (Test-Native git diff --cached --quiet)) {
        $null = Invoke-Native git commit -m 'Configure dev and prod Firebase environments'
        Ok 'committed environment configuration on main'
    } else { Ok 'nothing new to commit on main' }
    $null = Invoke-Native git push -u origin main
    Ok 'main pushed'

    if (-not (Test-Native git show-ref --verify --quiet refs/heads/dev)) {
        if (Test-Native git show-ref --verify --quiet refs/remotes/origin/dev) { $null = Invoke-Native git branch dev origin/dev }
        else { $null = Invoke-Native git branch dev main }
        Ok 'local dev branch created'
    }
    $null = Invoke-Native git checkout dev
    $null = Invoke-Native git merge --ff-only main
    $null = Invoke-Native git push -u origin dev
    Ok 'dev pushed (checked out: dev)'
}

Step 'Done'
Write-Host @"
    Active Firebase alias : dev  ($DEV)
    Deploy dev            : npm run deploy:dev     (branch dev, clean, pushed)
    Deploy prod           : npm run deploy:prod    (branch main, clean, pushed)
    Before first functions deploy to dev:
      firebase functions:secrets:set GMAIL_APP_PASSWORD --project dev
    Dev also needs: Blaze plan, Storage bucket, Realtime Database (default) instance.
"@
