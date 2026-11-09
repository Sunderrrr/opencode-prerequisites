#Requires -Version 5.1
<#
.SYNOPSIS
  Native Windows installer for the OpenCode prerequisites kit.

.DESCRIPTION
  Runs the Bash installer through Git Bash (config-only by default), then adds the
  Windows integration the Bash kit cannot provide:
    - .cmd shims in %USERPROFILE%\.local\bin for every launcher;
    - the user PATH entry (HKCU\Environment, no administrator rights);
    - opencode.jsonc rewritten from {env:HOME}/.local/bin/... to
      {env:USERPROFILE}/.local/bin/....cmd;
    - an idempotent OPENCODE_CONFIG_DIR block in the PowerShell profile.

  Native Windows is config-only: Trivy, Obscura, Playwright Chromium, Semgrep,
  MemPalace, the pentest binaries and Android/Podman need WSL2. -Full and the
  default tools path therefore print a warning and run with --no-tools.

.PARAMETER Profile
  core, full or lite (forwarded to install.sh --profile).

.PARAMETER With
  Comma-separated packs to add (forwarded to install.sh --with).

.PARAMETER Without
  Comma-separated packs to remove (forwarded to install.sh --without).

.PARAMETER NoTools
  Config only. This is the tested native path (implied on Windows anyway).

.PARAMETER Android
  Install the Android module files (the Podman/emulator runtime still needs WSL2).

.PARAMETER Force
  Overwrite kit files you have modified (forwarded to install.sh --force-config).

.PARAMETER Lite
  Alias of -Profile lite (implies config-only).

.PARAMETER Full
  Ask for the full profile; tools are skipped with a WSL2 warning on native Windows.

.PARAMETER DryRun
  Print the planned actions without writing anything.

.PARAMETER RepairOnly
  Internal/doctor use: do not run install.sh, only repair shims, PATH, profile and
  the opencode.jsonc Windows rewrite.

.PARAMETER ProfilePath
  Override the PowerShell profile path (testing/advanced). Defaults to
  $PROFILE.CurrentUserAllHosts.
#>
[CmdletBinding()]
param(
  [ValidateSet('core', 'full', 'lite')]
  [string]$Profile,
  [string]$With,
  [string]$Without,
  [switch]$NoTools,
  [switch]$Android,
  [switch]$Force,
  [switch]$Lite,
  [switch]$Full,
  [switch]$DryRun,
  [switch]$RepairOnly,
  [string]$ProfilePath
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$script:ShimMarker = '@rem opencode-prerequisites'

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

function Test-WindowsHost {
  if (Test-Path Variable:IsWindows) { return [bool]$IsWindows }
  return ($env:OS -eq 'Windows_NT')
}

function Get-UserProfile {
  if ($env:USERPROFILE) { return (Normalize-Dir $env:USERPROFILE) }
  $p = [Environment]::GetFolderPath('UserProfile')
  if ([string]::IsNullOrWhiteSpace($p)) { throw 'USERPROFILE is not set: run this script as your normal Windows user.' }
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

# Windows-style normalization that also works on non-Windows hosts (unit tests).
function Normalize-WinPath {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
  return $Path.Replace('/', '\').TrimEnd([char[]]@('\'))
}

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok { param([string]$Message) Write-Host "✅ $Message" -ForegroundColor Green }
function Write-Note { param([string]$Message) Write-Host "⚠️  $Message" -ForegroundColor Yellow }
function Write-Problem { param([string]$Message) Write-Host "❌ $Message" -ForegroundColor Red }

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
  if (-not $cmd) {
    throw 'Node.js not found. Install Node.js 18+ (26 recommended): https://nodejs.org/ or "winget install OpenJS.NodeJS.LTS".'
  }
  $out = @(& $cmd.Source --version 2>&1)
  $rc = $LASTEXITCODE
  if ($rc -ne 0) { throw "Node.js was found at $($cmd.Source) but 'node --version' failed (exit $rc)." }
  $version = (($out -join "`n").Trim())
  $major = Get-NodeMajor $version
  if ($major -lt 18) { throw "Node.js $version is too old: 18+ is required (26 recommended)." }
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
      $gitBin = Join-Path $root 'bin'
      $gitUsrBin = Join-Path $root 'usr\bin'
      return [pscustomobject]@{
        Bash   = $candidate
        Root   = $root
        Bin    = $gitBin
        UsrBin = $gitUsrBin
        Name   = $name
      }
    }
    if ($rc -eq 0 -and $name -match '^Linux') { $wslFound = $true }
  }

  $message = 'Git Bash not found. Install Git for Windows (https://git-scm.com/download/win) and keep "Git from the command line and also from 3rd-party software" selected.'
  if ($wslFound) { $message += ' A WSL bash.exe was found, but the kit needs Git Bash (MSYS/Cygwin), not WSL.' }
  throw $message
}

function ConvertTo-PosixPath {
  param([string]$BashPath, [string]$WindowsPath)
  $out = @(& $BashPath -c 'cygpath -u "$1"' _ $WindowsPath 2>&1)
  if ($LASTEXITCODE -eq 0) {
    $posix = (($out -join "`n").Trim())
    if ($posix) { return $posix }
  }
  # Fallback for a minimal MSYS installation without cygpath.
  $p = $WindowsPath.Replace('\', '/')
  if ($p -match '^([A-Za-z]):/(.*)$') { $p = '/' + $Matches[1].ToLowerInvariant() + '/' + $Matches[2] }
  return $p
}

function Test-OpenCode {
  $cmd = Get-Command -Name 'opencode.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandType -eq 'Application' } | Select-Object -First 1
  if (-not $cmd) {
    $cmd = Get-Command -Name 'opencode' -ErrorAction SilentlyContinue | Select-Object -First 1
  }
  if (-not $cmd) {
    Write-Note 'opencode not found. Install it first: scoop install opencode | choco install opencode | mise use -g github:anomalyco/opencode'
    Write-Note 'The configuration is installed anyway; doctor.ps1 will report opencode as missing until you install it.'
    return $null
  }
  $out = @(& $cmd.Source --version 2>&1)
  if ($LASTEXITCODE -ne 0) {
    Write-Note "opencode was found at $($cmd.Source) but 'opencode --version' failed; doctor.ps1 will report it."
    return $null
  }
  $version = (($out -join "`n").Trim())
  Write-Ok "opencode $version"
  return $cmd.Source
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

function Get-MemPalacePython {
  if ($env:MEMPALACE_ADAPTER_PYTHON) { return $env:MEMPALACE_ADAPTER_PYTHON }
  $home = Get-UserProfile
  foreach ($candidate in @(
      (Join-Path $home '.mempalace\venv\Scripts\python.exe'),
      (Join-Path $home '.mempalace\venv\bin\python'))) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return $null
}

# ---------------------------------------------------------------------------
# Pure text/path helpers (unit-tested by scripts/test-windows.ps1)
# ---------------------------------------------------------------------------

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

function Get-ShimTarget {
  param([string]$Name, [string]$ConfigDir, [string]$BinDir)
  $candidate = Join-Path (Join-Path $ConfigDir 'bin') $Name
  if (Test-Path -LiteralPath $candidate) { return $candidate }
  $candidate = Join-Path $BinDir $Name
  if (Test-Path -LiteralPath $candidate) { return $candidate }
  return $null
}

function Get-ShimContent {
  param(
    [string]$BashPath,
    [string]$Target,
    [string]$Name,
    [string]$ChromePath,
    [string]$ChromeEnv
  )
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add('@echo off')
  $lines.Add('@rem opencode-prerequisites: generated Windows shim for ' + $Name + ' (do not edit)')
  $lines.Add('setlocal')
  if ($ChromePath -and $ChromeEnv) {
    $lines.Add('if not defined ' + $ChromeEnv + ' set "' + $ChromeEnv + '=' + $ChromePath + '"')
  }
  $lines.Add('"' + $BashPath + '" "' + $Target + '" %*')
  $lines.Add('exit /b %ERRORLEVEL%')
  return (($lines -join "`r`n") + "`r`n")
}

function Update-OpenCodeConfigText {
  param(
    [string]$Text,
    [string]$ConfigDir,
    [string]$BinDir,
    [string[]]$LauncherNames,
    [string]$UserProfile = $env:USERPROFILE
  )
  if ([string]::IsNullOrWhiteSpace($UserProfile)) { throw 'Update-OpenCodeConfigText: UserProfile is required.' }
  $profileRoot = $UserProfile.TrimEnd([char[]]@('\', '/'))
  $binRef = '{env:USERPROFILE}/.local/bin'
  $defaultBin = Normalize-WinPath ($profileRoot + '\.local\bin')
  if (-not [string]::Equals((Normalize-WinPath $BinDir), $defaultBin, [StringComparison]::OrdinalIgnoreCase)) {
    $binRef = (Normalize-WinPath $BinDir).Replace('\', '/')
  }
  $cfgRef = '{env:USERPROFILE}/.config/opencode'
  $defaultCfg = Normalize-WinPath ($profileRoot + '\.config\opencode')
  if (-not [string]::Equals((Normalize-WinPath $ConfigDir), $defaultCfg, [StringComparison]::OrdinalIgnoreCase)) {
    $cfgRef = (Normalize-WinPath $ConfigDir).Replace('\', '/')
  }

  foreach ($name in $LauncherNames) {
    $pattern = '\{env:HOME\}/\.local/bin/' + [regex]::Escape($name) + '(?=["\s]|$)'
    $placeholder = '__OC_SHIM_' + [guid]::NewGuid().ToString('N') + '__'
    $Text = [regex]::Replace($Text, $pattern, $placeholder)
    $Text = $Text.Replace($placeholder, $binRef + '/' + $name + '.cmd')
  }
  $Text = $Text.Replace('{env:HOME}/.local/bin/', $binRef + '/')
  $Text = $Text.Replace('{env:HOME}/.config/opencode', $cfgRef)
  $Text = $Text.Replace('{env:HOME}', '{env:USERPROFILE}')
  return $Text
}

function Update-ProfileText {
  param(
    [string]$Text,
    [string]$ConfigDir,
    [string]$MemPython
  )
  $begin = '# >>> opencode-prerequisites (windows) >>>'
  $end = '# <<< opencode-prerequisites (windows) <<<'
  $pattern = '(?ms)^' + [regex]::Escape($begin) + '\r?\n.*?^' + [regex]::Escape($end) + '\r?\n?'
  $clean = [regex]::Replace($Text, $pattern, '')
  $clean = $clean.TrimEnd([char[]]@("`r", "`n"))

  $escapedConfig = $ConfigDir.Replace("'", "''")
  $block = New-Object System.Collections.Generic.List[string]
  $block.Add($begin)
  $block.Add("`$env:OPENCODE_CONFIG_DIR = '$escapedConfig'")
  if ($MemPython) {
    $escapedMem = $MemPython.Replace("'", "''")
    $block.Add("`$env:MEMPALACE_ADAPTER_PYTHON = '$escapedMem'")
  }
  $block.Add($end)
  $blockText = ($block -join "`r`n")

  if ($clean.Length -gt 0) { return ($clean + "`r`n`r`n" + $blockText + "`r`n") }
  return ($blockText + "`r`n")
}

function Remove-ProfileBlockText {
  param([string]$Text)
  $begin = '# >>> opencode-prerequisites (windows) >>>'
  $end = '# <<< opencode-prerequisites (windows) <<<'
  $pattern = '(?ms)^' + [regex]::Escape($begin) + '\r?\n.*?^' + [regex]::Escape($end) + '\r?\n?'
  $clean = [regex]::Replace($Text, $pattern, '')
  return $clean.TrimEnd([char[]]@("`r", "`n"))
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

function Remove-UserPathEntry {
  param([string]$Current, [string]$BinDir)
  $target = (Normalize-WinPath $BinDir)
  $entries = New-Object System.Collections.Generic.List[string]
  if ($Current) {
    foreach ($raw in ($Current -split ';')) {
      $entry = $raw.Trim()
      if ($entry -eq '') { continue }
      $expanded = [Environment]::ExpandEnvironmentVariables($entry)
      if ([string]::Equals((Normalize-WinPath $expanded), $target, [StringComparison]::OrdinalIgnoreCase)) { continue }
      $entries.Add($entry)
    }
  }
  return ($entries -join ';')
}

# ---------------------------------------------------------------------------
# Registry / profile / shims
# ---------------------------------------------------------------------------

function Get-UserPath {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
  if (-not $key) { return '' }
  try {
    $value = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    return [string]$value
  } finally { $key.Close() }
}

function Set-UserPath {
  param([string]$Value)
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  if (-not $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }
  try {
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    try { $kind = $key.GetValueKind('Path') } catch { }
    $key.SetValue('Path', $Value, $kind)
  } finally { $key.Close() }
}

function Add-UserPath {
  param([string]$BinDir, [switch]$DryRun)
  $current = Get-UserPath
  $new = Merge-UserPath -Current $current -BinDir $BinDir
  if ($new -eq $current) {
    Write-Ok "User PATH already contains $BinDir"
    return
  }
  if ($DryRun) {
    Write-Host "   would add to user PATH: $BinDir"
    return
  }
  Set-UserPath $new
  Write-Ok "User PATH updated: $BinDir"
}

function Add-ProcessPath {
  param([string]$BinDir)
  $current = $env:PATH
  $new = Merge-UserPath -Current $current -BinDir $BinDir
  if ($new -ne $current) { $env:PATH = $new }
}

function Install-Shims {
  param(
    [string]$ConfigDir,
    [string]$BinDir,
    [string]$BashPath,
    [string]$ChromePath,
    [switch]$DryRun
  )
  $names = Get-LauncherNames -ConfigDir $ConfigDir -BinDir $BinDir
  $created = 0
  $updated = 0
  $skipped = 0
  foreach ($name in $names) {
    $target = Get-ShimTarget -Name $name -ConfigDir $ConfigDir -BinDir $BinDir
    if (-not $target) {
      Write-Note "launcher $name not found (shim skipped)"
      $skipped++
      continue
    }
    $chrome = $null
    $chromeEnv = $null
    if ($ChromePath) {
      if ($name -eq 'oc-playwright-mcp') { $chromeEnv = 'OC_PLAYWRIGHT_BROWSER'; $chrome = $ChromePath }
      elseif ($name -eq 'oc-chrome-devtools-mcp') { $chromeEnv = 'OC_CHROME_PATH'; $chrome = $ChromePath }
    }
    $content = Get-ShimContent -BashPath $BashPath -Target $target -Name $name -ChromePath $chrome -ChromeEnv $chromeEnv
    $shim = Join-Path $BinDir ($name + '.cmd')
    if ($DryRun) {
      Write-Host "   would write shim: $shim"
      continue
    }
    $old = $null
    if (Test-Path -LiteralPath $shim) { $old = [IO.File]::ReadAllText($shim) }
    if ($old -eq $content) { continue }
    [IO.File]::WriteAllText($shim, $content, [Text.Encoding]::Default)
    if ($null -eq $old) { $created++ } else { $updated++ }
  }
  if ($DryRun) {
    Write-Host "   would install $($names.Count) .cmd shim(s) in $BinDir"
  } else {
    Write-Ok "Windows shims: $created created, $updated updated, $skipped skipped"
  }
}

function Update-OpenCodeConfig {
  param(
    [string]$ConfigFile,
    [string]$ConfigDir,
    [string]$BinDir,
    [string[]]$LauncherNames,
    [switch]$DryRun
  )
  if (-not (Test-Path -LiteralPath $ConfigFile)) {
    Write-Note "opencode.jsonc not found: $ConfigFile (run install.ps1 first)"
    return
  }
  $text = [IO.File]::ReadAllText($ConfigFile)
  $new = Update-OpenCodeConfigText -Text $text -ConfigDir $ConfigDir -BinDir $BinDir -LauncherNames $LauncherNames -UserProfile (Get-UserProfile)
  if ($new -eq $text) {
    Write-Ok 'opencode.jsonc already Windows-ready'
    return
  }
  if ($DryRun) {
    Write-Host "   would rewrite $ConfigFile (launchers -> .cmd, no {env:HOME})"
    return
  }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = "$ConfigFile.bak-$stamp"
  $n = 1
  while (Test-Path -LiteralPath $backup) { $backup = "$ConfigFile.bak-$stamp-$n"; $n++ }
  Copy-Item -LiteralPath $ConfigFile -Destination $backup -Force
  [IO.File]::WriteAllText($ConfigFile, $new, (New-Object Text.UTF8Encoding($false)))
  Write-Ok "opencode.jsonc rewritten (backup: $backup)"
}

function Set-McpDisabled {
  param(
    [string]$Server,
    [string]$Reason,
    [string]$ConfigFile,
    [string]$NodePath,
    [string]$RepoRoot
  )
  $helper = Join-Path $RepoRoot 'scripts\lib\mcp-state.mjs'
  if (-not (Test-Path -LiteralPath $helper)) {
    Write-Note "mcp-state helper not found: $helper"
    return
  }
  & $NodePath $helper disable $ConfigFile $Server $Reason
  $rc = $LASTEXITCODE
  if ($rc -eq 0) { Write-Ok "MCP $Server disabled ($Reason)" }
  elseif ($rc -eq 2) { Write-Note "MCP $Server not present in opencode.jsonc" }
  else { Write-Note "MCP $Server could not be disabled (exit $rc)" }
}

function Update-McpAvailability {
  param(
    [string]$ConfigFile,
    [string]$NodePath,
    [string]$RepoRoot,
    [switch]$DryRun
  )
  if (-not (Test-Path -LiteralPath $ConfigFile)) { return }
  if ($DryRun) {
    Write-Host '   would disable trivy/obscura/terraform when their native prerequisites are missing'
    return
  }
  if (-not (Get-Command -Name 'trivy' -ErrorAction SilentlyContinue)) {
    Set-McpDisabled -Server 'trivy' -Reason 'native Windows: Trivy not found (install Trivy or use WSL2)' -ConfigFile $ConfigFile -NodePath $NodePath -RepoRoot $RepoRoot
  }
  if (-not (Get-Command -Name 'obscura' -ErrorAction SilentlyContinue)) {
    Set-McpDisabled -Server 'obscura' -Reason 'native Windows: Obscura not found (use WSL2 for the full toolchain)' -ConfigFile $ConfigFile -NodePath $NodePath -RepoRoot $RepoRoot
  }
  $hasDocker = [bool](Get-Command -Name 'docker' -ErrorAction SilentlyContinue)
  $hasPodman = [bool](Get-Command -Name 'podman' -ErrorAction SilentlyContinue)
  if (-not $hasDocker -and -not $hasPodman) {
    Set-McpDisabled -Server 'terraform' -Reason 'native Windows: Docker Desktop or WSL2 required for the Terraform MCP' -ConfigFile $ConfigFile -NodePath $NodePath -RepoRoot $RepoRoot
  }
}

function Write-ProfileBlock {
  param(
    [string]$ProfileFile,
    [string]$ConfigDir,
    [string]$MemPython,
    [switch]$DryRun
  )
  $text = ''
  if (Test-Path -LiteralPath $ProfileFile) { $text = [IO.File]::ReadAllText($ProfileFile) }
  $new = Update-ProfileText -Text $text -ConfigDir $ConfigDir -MemPython $MemPython
  if ($new -eq $text) {
    Write-Ok "PowerShell profile already configured: $ProfileFile"
    return
  }
  if ($DryRun) {
    Write-Host "   would write PowerShell profile block: $ProfileFile"
    return
  }
  $dir = Split-Path -Parent $ProfileFile
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  if (Test-Path -LiteralPath $ProfileFile) {
    $backup = "$ProfileFile.bak-opencode-prerequisites"
    if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $ProfileFile -Destination $backup -Force }
  }
  [IO.File]::WriteAllText($ProfileFile, $new, (New-Object Text.UTF8Encoding($false)))
  Write-Ok "PowerShell profile updated: $ProfileFile"
}

# ---------------------------------------------------------------------------
# install.sh invocation
# ---------------------------------------------------------------------------

function Build-BashArguments {
  if ($Lite -and $Profile) { throw 'Use either -Lite or -Profile, not both.' }
  if ($Full -and $Profile) { throw 'Use either -Full or -Profile, not both.' }
  if ($Full -and $Lite) { throw 'Use either -Full or -Lite, not both.' }
  $arguments = New-Object System.Collections.Generic.List[string]
  $arguments.Add('--no-tools')
  if ($Lite) { $arguments.Add('--lite') }
  elseif ($Full) { $arguments.Add('--profile'); $arguments.Add('full') }
  elseif ($Profile) { $arguments.Add('--profile'); $arguments.Add($Profile) }
  if ($With) { $arguments.Add('--with'); $arguments.Add($With) }
  if ($Without) { $arguments.Add('--without'); $arguments.Add($Without) }
  if ($Android) { $arguments.Add('--android') }
  if ($Force) { $arguments.Add('--force-config') }
  return $arguments.ToArray()
}

function Invoke-BashInstaller {
  param(
    [string]$RepoRoot,
    [string]$Bash,
    [string]$GitBin,
    [string]$GitUsrBin,
    [string]$ConfigDir,
    [string]$BinDir,
    [string[]]$Arguments
  )
  $installSh = Join-Path $RepoRoot 'install.sh'
  if (-not (Test-Path -LiteralPath $installSh)) { throw "install.sh not found in $RepoRoot" }
  $posixInstall = ConvertTo-PosixPath -BashPath $Bash -WindowsPath $installSh
  $saved = @{
    OPENCODE_CONFIG_DIR = $env:OPENCODE_CONFIG_DIR
    OBSCURA_BIN_DIR     = $env:OBSCURA_BIN_DIR
    HOME                = $env:HOME
    PATH                = $env:PATH
  }
  try {
    $env:OPENCODE_CONFIG_DIR = $ConfigDir
    $env:OBSCURA_BIN_DIR = $BinDir
    $env:HOME = ConvertTo-PosixPath -BashPath $Bash -WindowsPath (Get-UserProfile)
    $env:PATH = (($GitBin, $GitUsrBin, $env:PATH, $BinDir) -join ';')
    Push-Location $RepoRoot
    try {
      & $Bash $posixInstall @Arguments
      $rc = $LASTEXITCODE
    } finally { Pop-Location }
    if ($rc -ne 0) { throw "install.sh failed with exit code $rc" }
  } finally {
    foreach ($key in $saved.Keys) {
      if ($null -eq $saved[$key]) { Remove-Item -Path "Env:$key" -ErrorAction SilentlyContinue }
      else { Set-Item -Path "Env:$key" -Value $saved[$key] -ErrorAction SilentlyContinue }
    }
  }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

function Main {
  if (-not (Test-WindowsHost)) {
    throw 'This script only supports native Windows. On Linux/macOS use ./install.sh; on Windows use WSL2 for the full toolchain.'
  }

  $repoRoot = $PSScriptRoot
  $configDir = Resolve-ConfigDir
  $binDir = Resolve-BinDir
  $profileFile = Resolve-ProfilePath -Override $ProfilePath
  $git = Find-GitBash
  $node = Get-NodeInfo
  $chrome = Find-Chrome

  Write-Step 'OpenCode kit — native Windows install'
  Write-Host "   Repository: $repoRoot"
  Write-Host "   Config:     $configDir"
  Write-Host "   Bin:        $binDir"
  Write-Host "   Profile:    $profileFile"
  Write-Ok "Git Bash: $($git.Bash)"
  Write-Ok "Node $($node.Version) ($($node.Path))"
  if ($chrome) { Write-Ok "Chrome/Chromium: $chrome" }
  else { Write-Note 'Chrome/Chromium not found: install Google Chrome or set OC_PLAYWRIGHT_BROWSER / OC_CHROME_PATH.' }

  if (-not $RepairOnly) {
    $bashArguments = Build-BashArguments
    $toolsRequested = (-not $NoTools -and -not $Lite) -or $Full
    if ($toolsRequested) {
      Write-Note 'Native Windows install is CONFIG-ONLY: no tool is downloaded or installed.'
      Write-Note 'Trivy, Obscura, Playwright Chromium, Semgrep, pentest binaries, MemPalace and Android/Podman require WSL2.'
      Write-Note 'For the full toolchain, run ./install.sh inside WSL2.'
    }
    if ($Android) {
      Write-Note 'Android module files will be copied, but Podman, /dev/kvm and the emulator require WSL2.'
    }
  }

  $launcherNames = Get-LauncherNames -ConfigDir $configDir -BinDir $binDir

  if ($DryRun) {
    Write-Step 'DRY RUN — nothing will be written'
    Write-Host "   Config dir:  $configDir"
    Write-Host "   Bin dir:     $binDir"
    Write-Host "   Profile:     $profileFile"
    if (-not $RepairOnly) {
      $installSh = Join-Path $repoRoot 'install.sh'
      $posixInstall = ConvertTo-PosixPath -BashPath $git.Bash -WindowsPath $installSh
      Write-Host "   Command:     bash $posixInstall $($bashArguments -join ' ')"
    } else {
      Write-Host '   Mode:        repair only (no install.sh)'
    }
    Write-Host "   Shims:       $($launcherNames.Count) .cmd file(s) in $binDir"
    Write-Host '   Config:      rewrite {env:HOME}/.local/bin/<x> -> {env:USERPROFILE}/.local/bin/<x>.cmd'
    Write-Host "   Profile:     idempotent OPENCODE_CONFIG_DIR block in $profileFile"
    Write-Host "   User PATH:   append $binDir (HKCU\\Environment, no admin)"
    Write-Host '   MCP:         disable trivy/obscura/terraform when their native prerequisites are missing'
    return
  }

  if (-not $RepairOnly) {
    Write-Step 'Running install.sh through Git Bash (config only)'
    Invoke-BashInstaller -RepoRoot $repoRoot -Bash $git.Bash -GitBin $git.Bin -GitUsrBin $git.UsrBin -ConfigDir $configDir -BinDir $binDir -Arguments $bashArguments
    Write-Ok 'install.sh completed'
    $launcherNames = Get-LauncherNames -ConfigDir $configDir -BinDir $binDir
  }

  Write-Step 'Creating Windows .cmd shims'
  Install-Shims -ConfigDir $configDir -BinDir $binDir -BashPath $git.Bash -ChromePath $chrome

  Write-Step 'Making opencode.jsonc Windows-native'
  Update-OpenCodeConfig -ConfigFile (Join-Path $configDir 'opencode.jsonc') -ConfigDir $configDir -BinDir $binDir -LauncherNames $launcherNames

  Write-Step 'Checking native MCP prerequisites'
  Update-McpAvailability -ConfigFile (Join-Path $configDir 'opencode.jsonc') -NodePath $node.Path -RepoRoot $repoRoot

  Write-Step 'Updating user PATH and PowerShell profile'
  Add-UserPath -BinDir $binDir
  Write-ProfileBlock -ProfileFile $profileFile -ConfigDir $configDir -MemPython (Get-MemPalacePython)
  Add-ProcessPath -BinDir $binDir

  Write-Step 'Native Windows install complete'
  Write-Host "   Config:  $configDir"
  Write-Host "   Shims:   $binDir\*.cmd"
  Write-Host "   Profile: $profileFile"
  Write-Host '   Open a NEW terminal (and restart OpenCode) so the user PATH and profile are loaded.'
  Write-Host '   Verify:  pwsh -NoProfile -File .\doctor.ps1 -Offline'
  Write-Host '   Remove:  pwsh -NoProfile -File .\uninstall.ps1'
}

if ($MyInvocation.InvocationName -ne '.') {
  try { Main } catch {
    Write-Problem $_.Exception.Message
    exit 1
  }
}
