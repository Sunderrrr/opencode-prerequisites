#Requires -Version 5.1
<#
.SYNOPSIS
  Windows diagnostic for the OpenCode prerequisites kit.

.DESCRIPTION
  Runs the Bash doctor through Git Bash (--offline by default in the Windows CI),
  then checks the Windows integration:
    - Git Bash and Node.js;
    - .cmd shims for every launcher;
    - the user PATH entry (HKCU\Environment);
    - HOME vs USERPROFILE and the absence of {env:HOME} in opencode.jsonc;
    - Chrome/Chromium (including the Playwright cache);
    - the PowerShell profile block.

  -Fix repairs missing shims, the PATH entry, the profile block and the
  opencode.jsonc Windows rewrite by calling install.ps1 -RepairOnly.

.PARAMETER Offline
  Pass --offline to doctor.sh: no network requests.

.PARAMETER Fix
  Repair the Windows integration (shims, PATH, profile, opencode.jsonc).

.PARAMETER ProfilePath
  Override the PowerShell profile path (testing/advanced).
#>
[CmdletBinding()]
param(
  [switch]$Offline,
  [switch]$Fix,
  [string]$ProfilePath
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$script:CheckPassed = 0
$script:CheckWarnings = 0
$script:CheckErrors = 0

function Test-WindowsHost {
  if (Test-Path Variable:IsWindows) { return [bool]$IsWindows }
  return ($env:OS -eq 'Windows_NT')
}

function Get-UserProfile {
  if ($env:USERPROFILE) { return (Normalize-Dir $env:USERPROFILE) }
  $p = [Environment]::GetFolderPath('UserProfile')
  if ([string]::IsNullOrWhiteSpace($p)) { throw 'USERPROFILE is not set.' }
  return (Normalize-Dir $p)
}

function Normalize-Dir {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  $p = [Environment]::ExpandEnvironmentVariables($Path.Trim())
  if (-not [IO.Path]::IsPathRooted($p)) { $p = Join-Path (Get-Location).Path $p }
  $p = [IO.Path]::GetFullPath($p)
  return $p.TrimEnd([char[]]@('\', '/'))
}

function Normalize-WinPath {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
  return $Path.Replace('/', '\').TrimEnd([char[]]@('\'))
}

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok { param([string]$Message) Write-Host "✅ $Message" -ForegroundColor Green }
function Write-Note { param([string]$Message) Write-Host "⚠️  $Message" -ForegroundColor Yellow }
function Write-Problem { param([string]$Message) Write-Host "❌ $Message" -ForegroundColor Red }

function Check {
  param([string]$Name, [bool]$Ok, [string]$Detail = '')
  if ($Ok) {
    $script:CheckPassed++
    Write-Ok $Name
  } else {
    $script:CheckErrors++
    if ($Detail) { Write-Problem "$Name — $Detail" } else { Write-Problem $Name }
  }
}

function Warn {
  param([string]$Name, [string]$Detail = '')
  $script:CheckWarnings++
  if ($Detail) { Write-Note "$Name — $Detail" } else { Write-Note $Name }
}

function Get-NodeMajor {
  param([string]$Version)
  if ($Version -match 'v?(\d+)\.') { return [int]$Matches[1] }
  return -1
}

function Get-NodeInfo {
  $cmd = Get-Command -Name 'node.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandType -eq 'Application' } | Select-Object -First 1
  if (-not $cmd) {
    $cmd = Get-Command -Name 'node' -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandType -eq 'Application' } | Select-Object -First 1
  }
  if (-not $cmd) { throw 'Node.js not found. Install Node.js 18+ (26 recommended).' }
  $out = @(& $cmd.Source --version 2>&1)
  $rc = $LASTEXITCODE
  if ($rc -ne 0) { throw "node --version failed (exit $rc)." }
  $version = (($out -join "`n").Trim())
  $major = Get-NodeMajor $version
  if ($major -lt 18) { throw "Node.js $version is too old (18+ required)." }
  return [pscustomobject]@{ Path = $cmd.Source; Version = $version; Major = $major }
}

function Find-GitBash {
  $candidates = New-Object System.Collections.Generic.List[string]
  $cmd = Get-Command -Name 'bash.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandType -eq 'Application' } | Select-Object -First 1
  if ($cmd -and $cmd.Source) { $candidates.Add($cmd.Source) }
  if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'Git\bin\bash.exe')) }
  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  if ($pf86) { $candidates.Add((Join-Path $pf86 'Git\bin\bash.exe')) }
  if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe')) }

  $wslFound = $false
  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    $uname = @(& $candidate -c 'uname -s' 2>&1)
    $rc = $LASTEXITCODE
    $name = (($uname -join "`n").Trim())
    if ($rc -eq 0 -and $name -match '^(MINGW|MSYS|CYGWIN)') {
      $root = Split-Path -Parent $candidate
      while ($root) {
        if ((Test-Path -LiteralPath (Join-Path $root 'cmd\git.exe')) -or (Test-Path -LiteralPath (Join-Path $root 'mingw64'))) { break }
        $next = Split-Path -Parent $root
        if (-not $next -or $next -eq $root) { break }
        $root = $next
      }
      if (-not $root) { $root = Split-Path -Parent (Split-Path -Parent $candidate) }
      return [pscustomobject]@{
        Bash   = $candidate
        Root   = $root
        Bin    = (Join-Path $root 'bin')
        UsrBin = (Join-Path $root 'usr\bin')
        Name   = $name
      }
    }
    if ($rc -eq 0 -and $name -match '^Linux') { $wslFound = $true }
  }
  $message = 'Git Bash not found. Install Git for Windows (https://git-scm.com/download/win).'
  if ($wslFound) { $message += ' A WSL bash.exe was found, but the kit needs Git Bash (MSYS/Cygwin).' }
  throw $message
}

function ConvertTo-PosixPath {
  param([string]$BashPath, [string]$WindowsPath)
  $out = @(& $BashPath -c 'cygpath -u "$1"' _ $WindowsPath 2>&1)
  if ($LASTEXITCODE -eq 0) {
    $posix = (($out -join "`n").Trim())
    if ($posix) { return $posix }
  }
  $p = $WindowsPath.Replace('\', '/')
  if ($p -match '^([A-Za-z]):/(.*)$') { $p = '/' + $Matches[1].ToLowerInvariant() + '/' + $Matches[2] }
  return $p
}

function Find-Chrome {
  param([string]$UserProfile = $env:USERPROFILE)
  $candidates = New-Object System.Collections.Generic.List[string]
  foreach ($name in @('chrome.exe', 'chromium.exe')) {
    $cmd = Get-Command -Name $name -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandType -eq 'Application' } | Select-Object -First 1
    if ($cmd -and $cmd.Source) { $candidates.Add($cmd.Source) }
  }
  foreach ($envName in @('ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA')) {
    $base = [Environment]::GetEnvironmentVariable($envName)
    if ($base) {
      $candidates.Add((Join-Path $base 'Google\Chrome\Application\chrome.exe'))
      $candidates.Add((Join-Path $base 'Chromium\Application\chrome.exe'))
    }
  }
  if ($UserProfile) {
    $candidates.Add((Join-Path $UserProfile 'AppData\Local\Google\Chrome\Application\chrome.exe'))
    $pwCache = Join-Path $UserProfile 'AppData\Local\ms-playwright'
    if (Test-Path -LiteralPath $pwCache) {
      Get-ChildItem -LiteralPath $pwCache -Directory -Filter 'chromium-*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | ForEach-Object {
          foreach ($rel in @(
              'chrome-win64\chrome.exe',
              'chrome-win\chrome.exe',
              'chrome-headless-shell-win64\headless_shell.exe',
              'chrome-headless-shell-win\headless_shell.exe')) {
            $candidates.Add((Join-Path $_.FullName $rel))
          }
        }
    }
  }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

function Get-LauncherNames {
  param([string]$ConfigDir, [string]$BinDir)
  $names = New-Object System.Collections.Generic.List[string]
  $configBin = Join-Path $ConfigDir 'bin'
  if (Test-Path -LiteralPath $configBin) {
    Get-ChildItem -LiteralPath $configBin -File -ErrorAction SilentlyContinue |
      ForEach-Object { $names.Add($_.Name) }
  }
  $names.Add('oc-new-rust')
  foreach ($name in @('oc-android', 'oc-mobile-mcp')) {
    if (Test-Path -LiteralPath (Join-Path $BinDir $name)) { $names.Add($name) }
  }
  return ($names | Sort-Object -Unique)
}

function Get-UserPath {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
  if (-not $key) { return '' }
  try {
    $value = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    return [string]$value
  } finally { $key.Close() }
}

function Merge-UserPath {
  param([string]$Current, [string]$BinDir)
  $target = (Normalize-WinPath $BinDir)
  $found = $false
  $entries = New-Object System.Collections.Generic.List[string]
  if ($Current) {
    foreach ($raw in ($Current -split ';')) {
      $entry = $raw.Trim()
      if ($entry -eq '') { continue }
      $expanded = [Environment]::ExpandEnvironmentVariables($entry)
      if ([string]::Equals((Normalize-WinPath $expanded), $target, [StringComparison]::OrdinalIgnoreCase)) { $found = $true }
      $entries.Add($entry)
    }
  }
  if (-not $found) { $entries.Add($BinDir) }
  return ($entries -join ';')
}

function Resolve-ConfigDir {
  if ($env:OPENCODE_CONFIG_DIR) { return (Normalize-Dir $env:OPENCODE_CONFIG_DIR) }
  return (Normalize-Dir (Join-Path (Get-UserProfile) '.config\opencode'))
}

function Resolve-BinDir {
  if ($env:OBSCURA_BIN_DIR) { return (Normalize-Dir $env:OBSCURA_BIN_DIR) }
  return (Normalize-Dir (Join-Path (Get-UserProfile) '.local\bin'))
}

function Resolve-ProfilePath {
  param([string]$Override)
  if ($Override) { return (Normalize-Dir $Override) }
  $p = $null
  try { $p = $PROFILE.CurrentUserAllHosts } catch { }
  if ([string]::IsNullOrWhiteSpace($p)) { $p = Join-Path (Get-UserProfile) 'Documents\PowerShell\profile.ps1' }
  return (Normalize-Dir $p)
}

function Invoke-BashDoctor {
  param(
    [pscustomobject]$Git,
    [string]$ConfigDir,
    [string]$BinDir,
    [bool]$OfflineMode
  )
  $doctorSh = Join-Path $PSScriptRoot 'doctor.sh'
  if (-not (Test-Path -LiteralPath $doctorSh)) { throw "doctor.sh not found in $PSScriptRoot" }
  $posixDoctor = ConvertTo-PosixPath -BashPath $Git.Bash -WindowsPath $doctorSh
  $saved = @{
    OPENCODE_CONFIG_DIR = $env:OPENCODE_CONFIG_DIR
    OBSCURA_BIN_DIR     = $env:OBSCURA_BIN_DIR
    HOME                = $env:HOME
    PATH                = $env:PATH
  }
  try {
    $env:OPENCODE_CONFIG_DIR = $ConfigDir
    $env:OBSCURA_BIN_DIR = $BinDir
    $env:HOME = ConvertTo-PosixPath -BashPath $Git.Bash -WindowsPath (Get-UserProfile)
    $env:PATH = (($Git.Bin, $Git.UsrBin, $env:PATH, $BinDir) -join ';')
    Push-Location $PSScriptRoot
    try {
      if ($OfflineMode) { & $Git.Bash $posixDoctor '--offline' } else { & $Git.Bash $posixDoctor }
      return $LASTEXITCODE
    } finally { Pop-Location }
  } finally {
    foreach ($key in $saved.Keys) {
      if ($null -eq $saved[$key]) { Remove-Item -Path "Env:$key" -ErrorAction SilentlyContinue }
      else { Set-Item -Path "Env:$key" -Value $saved[$key] -ErrorAction SilentlyContinue }
    }
  }
}

function Invoke-Repair {
  param([string]$ConfigDir, [string]$BinDir, [string]$ProfileFile)
  $installPs1 = Join-Path $PSScriptRoot 'install.ps1'
  if (-not (Test-Path -LiteralPath $installPs1)) { throw "install.ps1 not found in $PSScriptRoot" }
  $pwsh = (Get-Process -Id $PID).Path
  $savedConfig = $env:OPENCODE_CONFIG_DIR
  $savedBin = $env:OBSCURA_BIN_DIR
  try {
    $env:OPENCODE_CONFIG_DIR = $ConfigDir
    $env:OBSCURA_BIN_DIR = $BinDir
    & $pwsh -NoProfile -ExecutionPolicy Bypass -File $installPs1 -RepairOnly -NoTools -ProfilePath $ProfileFile
    return $LASTEXITCODE
  } finally {
    if ($null -eq $savedConfig) { Remove-Item -Path Env:OPENCODE_CONFIG_DIR -ErrorAction SilentlyContinue }
    else { $env:OPENCODE_CONFIG_DIR = $savedConfig }
    if ($null -eq $savedBin) { Remove-Item -Path Env:OBSCURA_BIN_DIR -ErrorAction SilentlyContinue }
    else { $env:OBSCURA_BIN_DIR = $savedBin }
  }
}

function Test-ConfigLaunchers {
  param([string]$ConfigFile, [string]$ConfigDir, [string]$BinDir, [string[]]$LauncherNames)
  if (-not (Test-Path -LiteralPath $ConfigFile)) {
    Check 'opencode.jsonc exists' $false $ConfigFile
    return
  }
  Check 'opencode.jsonc exists' $true
  $text = [IO.File]::ReadAllText($ConfigFile)
  Check 'opencode.jsonc no longer requires {env:HOME}' ($text -notmatch '\{env:HOME\}')

  $mcpLaunchers = @('oc-playwright-mcp', 'oc-chrome-devtools-mcp', 'oc-terraform-mcp', 'oc-semgrep-mcp', 'oc-rea-mcp', 'oc-mobile-mcp')
  $bad = New-Object System.Collections.Generic.List[string]
  foreach ($name in $mcpLaunchers) {
    $withoutCmd = '/.local/bin/' + $name + '"'
    if ($text.Contains($withoutCmd)) { $bad.Add($name) }
  }
  Check 'MCP launchers point to .cmd shims' ($bad.Count -eq 0) ($bad -join ', ')
}

function Main {
  if (-not (Test-WindowsHost)) {
    throw 'This script only supports native Windows. On Linux/macOS use ./doctor.sh.'
  }

  $configDir = Resolve-ConfigDir
  $binDir = Resolve-BinDir
  $profileFile = Resolve-ProfilePath -Override $ProfilePath

  Write-Step 'OpenCode kit — Windows diagnostic'
  Write-Host "   Config:  $configDir"
  Write-Host "   Bin:     $binDir"
  Write-Host "   Profile: $profileFile"
  Write-Host ''

  $git = $null
  $node = $null
  try {
    $git = Find-GitBash
    Check 'Git Bash present' $true $git.Bash
  } catch {
    Check 'Git Bash present' $false $_.Exception.Message
  }
  try {
    $node = Get-NodeInfo
    Check "Node $($node.Version) (18+)" $true
  } catch {
    Check 'Node.js 18+' $false $_.Exception.Message
  }

  if ($Fix) {
    Write-Step 'Repairing Windows integration (install.ps1 -RepairOnly)'
    try {
      $rc = Invoke-Repair -ConfigDir $configDir -BinDir $binDir -ProfileFile $profileFile
      if ($rc -eq 0) { Write-Ok 'Repair completed' } else { Write-Problem "Repair failed (exit $rc)" }
    } catch {
      Write-Problem "Repair failed: $($_.Exception.Message)"
    }
  }

  $bashRc = 1
  if ($git) {
    Write-Step 'Bash doctor (kit checks)'
    try {
      $bashRc = Invoke-BashDoctor -Git $git -ConfigDir $configDir -BinDir $binDir -OfflineMode ([bool]$Offline)
    } catch {
      Write-Problem "doctor.sh could not run: $($_.Exception.Message)"
    }
  } else {
    Write-Problem 'doctor.sh not run: Git Bash is missing.'
  }

  Write-Step 'Windows checks'
  $launcherNames = Get-LauncherNames -ConfigDir $configDir -BinDir $binDir

  $missingShims = New-Object System.Collections.Generic.List[string]
  foreach ($name in $launcherNames) {
    $shim = Join-Path $binDir ($name + '.cmd')
    if (-not (Test-Path -LiteralPath $shim)) {
      $missingShims.Add($name)
      continue
    }
    $content = [IO.File]::ReadAllText($shim)
    if (-not $content.Contains('@rem opencode-prerequisites')) { $missingShims.Add("$name (marker)") }
  }
  Check ".cmd shims present ($($launcherNames.Count) launchers)" ($missingShims.Count -eq 0) ($missingShims -join ', ')

  $userPath = Get-UserPath
  $merged = Merge-UserPath -Current $userPath -BinDir $binDir
  Check 'User PATH contains the bin directory' ($merged -eq $userPath) $binDir
  $processPath = ($env:PATH -split ';') | ForEach-Object { $_.Trim() }
  $inProcess = $false
  foreach ($entry in $processPath) {
    if ([string]::Equals((Normalize-WinPath ([Environment]::ExpandEnvironmentVariables($entry))), (Normalize-WinPath $binDir), [StringComparison]::OrdinalIgnoreCase)) { $inProcess = $true }
  }
  if (-not $inProcess) { Warn 'Current PowerShell PATH does not contain the bin directory (open a new terminal)' $binDir }

  $homeEnv = $env:HOME
  if ($homeEnv) {
    $normHome = Normalize-WinPath ([Environment]::ExpandEnvironmentVariables($homeEnv))
    $normProfile = Normalize-WinPath (Get-UserProfile)
    if (-not [string]::Equals($normHome, $normProfile, [StringComparison]::OrdinalIgnoreCase)) {
      Warn 'HOME differs from USERPROFILE (Git Bash launchers may use another home)' "$homeEnv vs $normProfile"
    } else {
      Check 'HOME matches USERPROFILE' $true
    }
  } else {
    Check 'HOME is not required (unset; Git Bash derives it from USERPROFILE)' $true
  }

  $profileOk = $false
  $profileDetail = $profileFile
  if (Test-Path -LiteralPath $profileFile) {
    $profileText = [IO.File]::ReadAllText($profileFile)
    $begin = '# >>> opencode-prerequisites (windows) >>>'
    $end = '# <<< opencode-prerequisites (windows) <<<'
    $beginCount = ([regex]::Matches($profileText, [regex]::Escape($begin))).Count
    $endCount = ([regex]::Matches($profileText, [regex]::Escape($end))).Count
    $hasConfig = $profileText -match [regex]::Escape($configDir)
    $profileOk = ($beginCount -eq 1 -and $endCount -eq 1 -and $hasConfig)
    if (-not $profileOk) { $profileDetail = "markers=$beginCount/$endCount, config path present=$hasConfig" }
  } else {
    $profileDetail = "file not found: $profileFile"
  }
  Check 'PowerShell profile block present' $profileOk $profileDetail

  Test-ConfigLaunchers -ConfigFile (Join-Path $configDir 'opencode.jsonc') -ConfigDir $configDir -BinDir $binDir -LauncherNames $launcherNames

  $chrome = Find-Chrome
  $pwCache = Join-Path (Get-UserProfile) 'AppData\Local\ms-playwright'
  if ($chrome) {
    if ($chrome.StartsWith($pwCache, [StringComparison]::OrdinalIgnoreCase)) { Check "Playwright Chromium: $chrome" $true }
    else { Check "Chrome/Chromium: $chrome" $true }
  } else {
    Warn "No Chrome/Chromium found (Playwright cache: $pwCache)" 'Install Google Chrome or set OC_PLAYWRIGHT_BROWSER / OC_CHROME_PATH.'
  }

  $memPy = $env:MEMPALACE_ADAPTER_PYTHON
  $nativeMem = Join-Path (Get-UserProfile) '.mempalace\venv\Scripts\python.exe'
  if ($memPy) {
    Check 'MEMPALACE_ADAPTER_PYTHON is set' (Test-Path -LiteralPath $memPy) $memPy
  } elseif (Test-Path -LiteralPath $nativeMem) {
    Warn 'MemPalace Python exists but MEMPALACE_ADAPTER_PYTHON is not set' $nativeMem
  }

  if (-not (Get-Command -Name 'opencode' -ErrorAction SilentlyContinue)) {
    Check 'opencode available' $false 'Install: scoop install opencode | choco install opencode | mise use -g github:anomalyco/opencode'
  } else {
    Check 'opencode available' $true
  }

  Write-Host ''
  Write-Host "Windows checks: $script:CheckPassed passed, $script:CheckWarnings warning(s), $script:CheckErrors error(s)"
  if ($bashRc -ne 0) {
    Write-Problem "doctor.sh exited $bashRc"
    $script:CheckErrors++
  }
  if ($script:CheckErrors -gt 0) { exit 1 }
  exit 0
}

try { Main } catch {
  Write-Problem $_.Exception.Message
  exit 1
}
