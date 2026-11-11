#Requires -Version 5.1
<#
.SYNOPSIS
  Uninstall the OpenCode prerequisites kit from native Windows.

.DESCRIPTION
  Runs the Bash uninstaller through Git Bash, removes the generated .cmd shims,
  removes the OPENCODE_CONFIG_DIR block from the PowerShell profile and removes
  the bin directory from the user PATH (HKCU\Environment, no admin).

  Backups are kept: <config>.bak-*, <config>.removed-*, opencode.jsonc.bak-*,
  and <profile>.bak-opencode-prerequisites.

.PARAMETER ProfilePath
  Override the PowerShell profile path (testing/advanced).

.PARAMETER DryRun
  Print the planned actions without changing anything.
#>
[CmdletBinding()]
param(
  [string]$ProfilePath,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

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

function Remove-ProfileBlockText {
  param([string]$Text)
  $begin = '# >>> opencode-prerequisites (windows) >>>'
  $end = '# <<< opencode-prerequisites (windows) <<<'
  $pattern = '(?ms)^' + [regex]::Escape($begin) + '\r?\n.*?^' + [regex]::Escape($end) + '\r?\n?'
  $clean = [regex]::Replace($Text, $pattern, '')
  return $clean.TrimEnd([char[]]@("`r", "`n"))
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

function Invoke-BashUninstall {
  param(
    [pscustomobject]$Git,
    [string]$ConfigDir,
    [string]$BinDir
  )
  $uninstallSh = Join-Path $PSScriptRoot 'uninstall.sh'
  if (-not (Test-Path -LiteralPath $uninstallSh)) { throw "uninstall.sh not found in $PSScriptRoot" }
  $posixUninstall = ConvertTo-PosixPath -BashPath $Git.Bash -WindowsPath $uninstallSh
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
    $env:PATH = (($Git.Bin, $Git.UsrBin, $env:PATH) -join ';')
    Push-Location $PSScriptRoot
    try {
      # Capture bash stdout/stderr separately from the exit code: piping them
      # into the pipeline would make this function return an array, and callers
      # comparing the result with -eq 0 would then misbehave.
      $out = @(& $Git.Bash $posixUninstall 2>&1)
      $rc = $LASTEXITCODE
      if ($out.Count -gt 0) { $out | Write-Host }
      return [int]$rc
    } finally { Pop-Location }
  } finally {
    foreach ($key in $saved.Keys) {
      if ($null -eq $saved[$key]) { Remove-Item -Path "Env:$key" -ErrorAction SilentlyContinue }
      else { Set-Item -Path "Env:$key" -Value $saved[$key] -ErrorAction SilentlyContinue }
    }
  }
}

function Main {
  if (-not (Test-WindowsHost)) {
    throw 'This script only supports native Windows. On Linux/macOS use ./uninstall.sh.'
  }

  $configDir = Resolve-ConfigDir
  $binDir = Resolve-BinDir
  $profileFile = Resolve-ProfilePath -Override $ProfilePath
  $launcherNames = Get-LauncherNames -ConfigDir $configDir -BinDir $binDir

  Write-Step 'OpenCode kit — Windows uninstall'
  Write-Host "   Config:  $configDir"
  Write-Host "   Bin:     $binDir"
  Write-Host "   Profile: $profileFile"
  if ($DryRun) { Write-Note 'DRY RUN — nothing will be changed' }

  $bashRc = 0
  if ($DryRun) {
    Write-Host '   would run: bash uninstall.sh (restore latest backup, remove Bash launchers)'
  } else {
    try {
      $git = Find-GitBash
      Write-Step 'Running uninstall.sh through Git Bash'
      $bashRc = Invoke-BashUninstall -Git $git -ConfigDir $configDir -BinDir $binDir
      if ($bashRc -eq 0) { Write-Ok 'uninstall.sh completed' } else { Write-Problem "uninstall.sh exited $bashRc" }
    } catch {
      $bashRc = 1
      Write-Problem "uninstall.sh could not run: $($_.Exception.Message)"
    }
  }

  Write-Step 'Removing Windows .cmd shims'
  $removedShims = 0
  if (Test-Path -LiteralPath $binDir) {
    foreach ($file in (Get-ChildItem -LiteralPath $binDir -Filter '*.cmd' -File -ErrorAction SilentlyContinue)) {
      $content = [IO.File]::ReadAllText($file.FullName)
      $isOurs = $content.Contains('@rem opencode-prerequisites')
      if (-not $isOurs) {
        $baseName = [IO.Path]::GetFileNameWithoutExtension($file.Name)
        $isOurs = $launcherNames -contains $baseName
      }
      if (-not $isOurs) { continue }
      if ($DryRun) {
        Write-Host "   would remove $($file.FullName)"
      } else {
        Remove-Item -LiteralPath $file.FullName -Force
        Write-Host "   🧹 $($file.FullName)"
      }
      $removedShims++
    }
  }
  if ($removedShims -eq 0) { Write-Ok 'No generated .cmd shim found' }
  else { Write-Ok "$removedShims .cmd shim(s) removed" }

  Write-Step 'Removing the PowerShell profile block'
  if (Test-Path -LiteralPath $profileFile) {
    $text = [IO.File]::ReadAllText($profileFile)
    $new = Remove-ProfileBlockText $text
    if ($new -eq $text) {
      Write-Ok 'No profile block found'
    } elseif ($DryRun) {
      Write-Host "   would remove the opencode-prerequisites block from $profileFile"
    } else {
      $backup = "$profileFile.bak-opencode-prerequisites"
      if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $profileFile -Destination $backup -Force }
      [IO.File]::WriteAllText($profileFile, $new, (New-Object Text.UTF8Encoding($false)))
      Write-Ok "Profile block removed (backup: $backup)"
    }
  } else {
    Write-Ok 'No PowerShell profile to clean'
  }

  Write-Step 'Removing the user PATH entry'
  $currentPath = Get-UserPath
  $newPath = Remove-UserPathEntry -Current $currentPath -BinDir $binDir
  if ($newPath -eq $currentPath) {
    Write-Ok 'User PATH does not contain the bin directory'
  } elseif ($DryRun) {
    Write-Host "   would remove $binDir from the user PATH"
  } else {
    Set-UserPath $newPath
    Write-Ok "User PATH entry removed: $binDir"
  }
  $processEntries = New-Object System.Collections.Generic.List[string]
  foreach ($raw in ($env:PATH -split ';')) {
    $entry = $raw.Trim()
    if ($entry -eq '') { continue }
    if ([string]::Equals((Normalize-WinPath ([Environment]::ExpandEnvironmentVariables($entry))), (Normalize-WinPath $binDir), [StringComparison]::OrdinalIgnoreCase)) { continue }
    $processEntries.Add($entry)
  }
  if (-not $DryRun) { $env:PATH = ($processEntries -join ';') }

  Write-Step 'Backups kept'
  $foundBackup = $false
  foreach ($pattern in @("$configDir.bak-*", "$configDir.removed-*", "$configDir\opencode.jsonc.bak-*", "$profileFile.bak-opencode-prerequisites")) {
    foreach ($item in (Get-Item -Path $pattern -ErrorAction SilentlyContinue)) {
      Write-Host "   · $($item.FullName)"
      $foundBackup = $true
    }
  }
  if (-not $foundBackup) { Write-Host '   (none)' }

  Write-Host ''
  if ($bashRc -ne 0) { exit 1 }
  exit 0
}

try { Main } catch {
  Write-Problem $_.Exception.Message
  exit 1
}
