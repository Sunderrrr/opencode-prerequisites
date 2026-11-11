#Requires -Version 5.1
<#
.SYNOPSIS
  Tests the native Windows scripts: install.ps1, uninstall.ps1 and doctor.ps1.

.DESCRIPTION
  -HelpersOnly parses every PowerShell script and unit-tests the pure helpers. It
  runs on any host with PowerShell 5.1+ or PowerShell 7 (Linux/macOS included).

  Without -HelpersOnly, it also exercises the Windows-only path end to end in a
  temporary home: install -DryRun, config-only install, doctor -Offline, then
  uninstall. That mode requires native Windows (Git Bash + Node.js + a writable
  HKCU\Environment).

  Exit code: 0 when every check passed, 1 otherwise.

.PARAMETER HelpersOnly
  Parse + pure helper tests only: no Windows-only command, no registry, no install.
#>
[CmdletBinding()]
param(
  [switch]$HelpersOnly
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:Passed = 0
$script:Failed = 0
$script:TempRoot = Join-Path ([IO.Path]::GetTempPath()) ('oc-windows-test-' + [guid]::NewGuid().ToString('N'))

function Write-TestHeader {
  param([string]$Name)
  Write-Host ''
  Write-Host "== $Name ==" -ForegroundColor Cyan
}

function Write-TestOk {
  param([string]$Name)
  Write-Host "  OK  $Name" -ForegroundColor Green
}

function Write-TestFail {
  param([string]$Name, [string]$Detail)
  Write-Host "  FAIL $Name" -ForegroundColor Red
  if ($Detail) { Write-Host "       $Detail" -ForegroundColor DarkGray }
}

function Assert {
  param([string]$Name, [bool]$Ok, [string]$Detail = '')
  if ($Ok) { $script:Passed++; Write-TestOk $Name }
  else { $script:Failed++; Write-TestFail $Name $Detail }
}

function Assert-Eq {
  param([string]$Name, $Expected, $Actual)
  $ok = $false
  if ($null -eq $Expected -and $null -eq $Actual) { $ok = $true }
  elseif ($null -ne $Expected -and $null -ne $Actual) {
    $ok = [string]::Equals([string]$Expected, [string]$Actual, [StringComparison]::Ordinal)
  }
  Assert $Name $ok ("expected [$Expected] got [$Actual]")
}

function Assert-Throws {
  param([string]$Name, [scriptblock]$Block)
  $threw = $false
  try { & $Block | Out-Null } catch { $threw = $true }
  Assert $Name $threw 'expected an exception, none was thrown'
}

function Get-ParseErrors {
  param([string]$Path)
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors) | Out-Null
  return $errors
}

function Assert-Parse {
  param([string]$Path)
  $errors = @(Get-ParseErrors $Path)
  $leaf = Split-Path -Leaf $Path
  if ($errors.Count -eq 0) { Assert "parse: $leaf" $true; return $true }
  $detail = ($errors | ForEach-Object { "$($_.Extent.StartLineNumber):$($_.Extent.StartColumnNumber) $($_.Message)" }) -join ' | '
  Assert "parse: $leaf" $false $detail
  return $false
}

# Parse a script and return its top-level function definitions as script blocks.
# Dot-source the blocks at script scope (". $block") to test a file's helpers
# without running its Main.
function Get-ScriptFunctionBlocks {
  param([string]$Path)
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  if ($errors.Count -gt 0) { throw "parse errors in $Path" }
  $nodes = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)
  foreach ($node in $nodes) { [scriptblock]::Create($node.Extent.Text) }
}

function Invoke-HostScript {
  param([string]$Path, [string[]]$Arguments = @())
  if ($PSVersionTable.PSEdition -eq 'Desktop') { $exe = Join-Path $PSHOME 'powershell.exe' }
  else { $exe = Join-Path $PSHOME 'pwsh.exe' }
  $output = & $exe -NoProfile -ExecutionPolicy Bypass -File $Path @Arguments 2>&1
  $rc = $LASTEXITCODE
  return [pscustomobject]@{
    ExitCode = $rc
    Output   = (($output | ForEach-Object { "$_" }) -join "`n")
  }
}

function New-TestDir {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
  return $Path
}

$installPs1 = Join-Path $script:RepoRoot 'install.ps1'
$uninstallPs1 = Join-Path $script:RepoRoot 'uninstall.ps1'
$doctorPs1 = Join-Path $script:RepoRoot 'doctor.ps1'
$testPs1 = $PSCommandPath

New-TestDir $script:TempRoot | Out-Null

try {
  Write-TestHeader 'Parse (PowerShell AST)'
  $installOk = Assert-Parse $installPs1
  $uninstallOk = Assert-Parse $uninstallPs1
  $doctorOk = Assert-Parse $doctorPs1
  Assert-Parse $testPs1 | Out-Null
  $parseOk = $installOk -and $uninstallOk -and $doctorOk

  if (-not $parseOk) {
    Write-Host 'Parse failed: skipping the remaining tests.' -ForegroundColor Red
  } else {
    # ---------------------------------------------------------------------
    # Reserved automatic variables must never be assigned: $HOME is read-only
    # in PowerShell 7.6+ and a failed assignment aborts install.ps1.
    # ---------------------------------------------------------------------
    Write-TestHeader 'Reserved automatic variables'
    $reserved = 'home|pid|pwd|input|args|error|host|true|false|null'
    foreach ($file in @($installPs1, $uninstallPs1, $doctorPs1, $testPs1)) {
      $text = [IO.File]::ReadAllText($file)
      $hits = [regex]::Matches($text, '(?im)^\s*\$(?:' + $reserved + ')\s*=')
      $leaf = Split-Path -Leaf $file
      Assert "automatic variables: no assignment in $leaf" ($hits.Count -eq 0) (($hits | ForEach-Object { $_.Value.Trim() }) -join ', ')
    }

    # ---------------------------------------------------------------------
    # install.ps1: dot-sourcing runs the param block but not Main.
    # ---------------------------------------------------------------------
    Write-TestHeader 'install.ps1 helpers'
    $savedProfile = $PROFILE
    . $installPs1
    $PROFILE = $savedProfile

    Assert-Eq 'normalize: forward slashes + trailing separator' 'C:\Users\me\.local\bin' (Normalize-WinPath 'C:/Users/me/.local/bin/')
    Assert-Eq 'normalize: empty input' '' (Normalize-WinPath '')
    Assert-Eq 'node major: v26.1.0' 26 (Get-NodeMajor 'v26.1.0')
    Assert-Eq 'node major: 18.0.0' 18 (Get-NodeMajor '18.0.0')
    Assert-Eq 'node major: invalid version' -1 (Get-NodeMajor 'not-a-version')

    $shim = Get-ShimContent -BashPath 'C:\Program Files\Git\bin\bash.exe' -Target 'C:\Users\me\.config\opencode\bin\oc-playwright-mcp' -Name 'oc-playwright-mcp' -ChromePath 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ChromeEnv 'OC_PLAYWRIGHT_BROWSER'
    Assert 'shim: @echo off' ($shim.Contains('@echo off'))
    Assert 'shim: generated marker' ($shim.Contains('@rem opencode-prerequisites: generated Windows shim for oc-playwright-mcp'))
    Assert 'shim: quoted bash, target and %*' ($shim.Contains('"C:\Program Files\Git\bin\bash.exe" "C:\Users\me\.config\opencode\bin\oc-playwright-mcp" %*'))
    Assert 'shim: Chrome env default' ($shim.Contains('if not defined OC_PLAYWRIGHT_BROWSER set "OC_PLAYWRIGHT_BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe"'))
    Assert 'shim: exit code propagated' ($shim.Contains('exit /b %ERRORLEVEL%'))
    Assert 'shim: CRLF line endings' ($shim.Contains("`r`n"))
    $plainShim = Get-ShimContent -BashPath 'bash.exe' -Target 'x' -Name 'oc-models'
    Assert 'shim: no Chrome line without a browser' (-not $plainShim.Contains('OC_PLAYWRIGHT_BROWSER'))

    $configText = @'
{
  "mcp": {
    "playwright": { "command": ["{env:HOME}/.local/bin/oc-playwright-mcp"] },
    "extra": { "command": ["{env:HOME}/.local/bin/oc-playwright-mcp-extra"] },
    "k8s": { "command": ["{env:HOME}/.config/opencode/k8s-mcp.toml"] }
  }
}
'@
    $rewritten = Update-OpenCodeConfigText -Text $configText -ConfigDir 'C:\Users\me\.config\opencode' -BinDir 'C:\Users\me\.local\bin' -LauncherNames @('oc-playwright-mcp') -UserProfile 'C:\Users\me'
    Assert 'config: launcher gets a .cmd suffix' ($rewritten.Contains('{env:USERPROFILE}/.local/bin/oc-playwright-mcp.cmd"'))
    Assert 'config: prefix-named tool is not truncated' ($rewritten.Contains('{env:USERPROFILE}/.local/bin/oc-playwright-mcp-extra"'))
    Assert 'config: config paths rewritten' ($rewritten.Contains('{env:USERPROFILE}/.config/opencode/k8s-mcp.toml'))
    Assert 'config: no {env:HOME} left' (-not $rewritten.Contains('{env:HOME}'))
    Assert-Eq 'config: idempotent' $rewritten (Update-OpenCodeConfigText -Text $rewritten -ConfigDir 'C:\Users\me\.config\opencode' -BinDir 'C:\Users\me\.local\bin' -LauncherNames @('oc-playwright-mcp') -UserProfile 'C:\Users\me')
    $customDirs = Update-OpenCodeConfigText -Text '"{env:HOME}/.local/bin/oc-models"' -ConfigDir 'D:\oc\config' -BinDir 'D:\oc\bin' -LauncherNames @('oc-models') -UserProfile 'C:\Users\me'
    Assert 'config: custom bin dir is absolute' ($customDirs.Contains('D:/oc/bin/oc-models.cmd'))
    $customConfig = Update-OpenCodeConfigText -Text '"{env:HOME}/.config/opencode/x"' -ConfigDir 'D:\oc\config' -BinDir 'D:\oc\bin' -LauncherNames @() -UserProfile 'C:\Users\me'
    Assert 'config: custom config dir is absolute' ($customConfig.Contains('D:/oc/config/x'))
    $mobileConfig = Update-OpenCodeConfigText -Text '{"mobile":{"disabled":true,"command":["{env:HOME}/.local/bin/oc-mobile-mcp"]}}' -ConfigDir 'C:\Users\me\.config\opencode' -BinDir 'C:\Users\me\.local\bin' -LauncherNames @() -UserProfile 'C:\Users\me'
    Assert 'config: disabled mobile launcher gets a .cmd suffix' ($mobileConfig.Contains('{env:USERPROFILE}/.local/bin/oc-mobile-mcp.cmd"'))
    Assert 'config: mobile keeps no {env:HOME}' (-not $mobileConfig.Contains('{env:HOME}'))
    Assert-Throws 'config: empty UserProfile is rejected' { Update-OpenCodeConfigText -Text 'x' -ConfigDir 'c' -BinDir 'b' -LauncherNames @() -UserProfile '' }

    $profileText = Update-ProfileText -Text '' -ConfigDir 'C:\Users\me\.config\opencode' -MemPython ''
    Assert 'profile: begin marker' ($profileText.Contains('# >>> opencode-prerequisites (windows) >>>'))
    Assert 'profile: config line' ($profileText.Contains("`$env:OPENCODE_CONFIG_DIR = 'C:\Users\me\.config\opencode'"))
    Assert 'profile: no MemPalace line without a native venv' (-not $profileText.Contains('MEMPALACE_ADAPTER_PYTHON'))
    Assert-Eq 'profile: idempotent' $profileText (Update-ProfileText -Text $profileText -ConfigDir 'C:\Users\me\.config\opencode' -MemPython '')
    Assert-Eq 'profile: one block only' 1 ([regex]::Matches($profileText, [regex]::Escape('# >>> opencode-prerequisites (windows) >>>')).Count)
    $userProfileText = Update-ProfileText -Text "# user line`r`n" -ConfigDir 'C:\Users\me\.config\opencode' -MemPython 'C:\Users\me\.mempalace\venv\Scripts\python.exe'
    Assert 'profile: user content preserved' ($userProfileText.StartsWith("# user line`r`n`r`n"))
    Assert 'profile: MemPalace python line' ($userProfileText.Contains("`$env:MEMPALACE_ADAPTER_PYTHON = 'C:\Users\me\.mempalace\venv\Scripts\python.exe'"))
    $replacedProfile = Update-ProfileText -Text $userProfileText -ConfigDir 'D:\other\opencode' -MemPython ''
    Assert 'profile: old block replaced' ((-not $replacedProfile.Contains('C:\Users\me\.config\opencode')) -and $replacedProfile.Contains('D:\other\opencode'))
    Assert 'profile: MemPalace line dropped on rerun' (-not $replacedProfile.Contains('MEMPALACE_ADAPTER_PYTHON'))
    Assert-Eq 'profile: remove block keeps user content' '# user line' (Remove-ProfileBlockText -Text $userProfileText)

    Assert-Eq 'path: appends a missing dir' 'C:\Windows;C:\Users\me\.local\bin' (Merge-UserPath -Current 'C:\Windows' -BinDir 'C:\Users\me\.local\bin')
    Assert-Eq 'path: no duplicate with a trailing slash' 'C:\Windows;C:\Users\me\.local\bin\' (Merge-UserPath -Current 'C:\Windows;C:\Users\me\.local\bin\' -BinDir 'C:\Users\me\.local\bin')
    Assert-Eq 'path: duplicate check is case-insensitive' 'C:\Windows;C:\Users\Me\.LOCAL\BIN' (Merge-UserPath -Current 'C:\Windows;C:\Users\Me\.LOCAL\BIN' -BinDir 'C:\Users\me\.local\bin')
    Assert-Eq 'path: empty current' 'C:\Users\me\.local\bin' (Merge-UserPath -Current '' -BinDir 'C:\Users\me\.local\bin')
    Assert-Eq 'path: removes an entry' 'C:\Windows;D:\tools' (Remove-UserPathEntry -Current 'C:\Windows;C:\Users\me\.local\bin;D:\tools' -BinDir 'C:\Users\me\.local\bin')
    Assert-Eq 'path: remove is case-insensitive' 'C:\Windows' (Remove-UserPathEntry -Current 'C:\Windows;C:\Users\Me\.LOCAL\BIN' -BinDir 'C:\Users\me\.local\bin')
    Assert-Eq 'path: remove leaves an absent entry alone' 'C:\Windows' (Remove-UserPathEntry -Current 'C:\Windows' -BinDir 'C:\Users\me\.local\bin')

    $savedConfigEnv = $env:OPENCODE_CONFIG_DIR
    $savedBinEnv = $env:OBSCURA_BIN_DIR
    try {
      $env:OPENCODE_CONFIG_DIR = Join-Path $script:TempRoot 'env-config'
      $env:OBSCURA_BIN_DIR = Join-Path $script:TempRoot 'env-bin'
      Assert-Eq 'dirs: OPENCODE_CONFIG_DIR override' (Normalize-Dir $env:OPENCODE_CONFIG_DIR) (Resolve-ConfigDir)
      Assert-Eq 'dirs: OBSCURA_BIN_DIR override' (Normalize-Dir $env:OBSCURA_BIN_DIR) (Resolve-BinDir)
    } finally {
      if ($null -eq $savedConfigEnv) { Remove-Item Env:OPENCODE_CONFIG_DIR -ErrorAction SilentlyContinue }
      else { $env:OPENCODE_CONFIG_DIR = $savedConfigEnv }
      if ($null -eq $savedBinEnv) { Remove-Item Env:OBSCURA_BIN_DIR -ErrorAction SilentlyContinue }
      else { $env:OBSCURA_BIN_DIR = $savedBinEnv }
    }

    $layoutConfig = New-TestDir (Join-Path $script:TempRoot 'layout\config')
    $layoutBin = New-TestDir (Join-Path $script:TempRoot 'layout\bin')
    New-TestDir (Join-Path $layoutConfig 'bin') | Out-Null
    foreach ($launcher in @('oc-models', 'oc-doctor', 'oc-playwright-mcp')) {
      [IO.File]::WriteAllText((Join-Path (Join-Path $layoutConfig 'bin') $launcher), 'launcher')
    }
    foreach ($launcher in @('oc-android', 'oc-mobile-mcp')) {
      [IO.File]::WriteAllText((Join-Path $layoutBin $launcher), 'launcher')
    }
    $launcherNames = @(Get-LauncherNames -ConfigDir $layoutConfig -BinDir $layoutBin)
    Assert 'launchers: sorted and unique' (($launcherNames -join ',') -eq (($launcherNames | Sort-Object -Unique) -join ','))
    Assert 'launchers: config/bin entries' (($launcherNames -contains 'oc-models') -and ($launcherNames -contains 'oc-doctor') -and ($launcherNames -contains 'oc-playwright-mcp'))
    Assert 'launchers: oc-new-rust always present' ($launcherNames -contains 'oc-new-rust')
    Assert 'launchers: bin fallback entries' (($launcherNames -contains 'oc-android') -and ($launcherNames -contains 'oc-mobile-mcp'))
    Assert-Eq 'shim target: config/bin wins' (Join-Path (Join-Path $layoutConfig 'bin') 'oc-models') (Get-ShimTarget -Name 'oc-models' -ConfigDir $layoutConfig -BinDir $layoutBin)
    Assert-Eq 'shim target: bin fallback' (Join-Path $layoutBin 'oc-android') (Get-ShimTarget -Name 'oc-android' -ConfigDir $layoutConfig -BinDir $layoutBin)
    Assert 'shim target: unknown launcher is null' ($null -eq (Get-ShimTarget -Name 'missing' -ConfigDir $layoutConfig -BinDir $layoutBin))

    $Lite = $false; $Full = $false; $Profile = $null; $With = $null; $Without = $null; $Android = $false; $Force = $false
    Assert-Eq 'args: config-only by default' '--no-tools' ((Build-BashArguments) -join ' ')
    $Lite = $true
    Assert-Eq 'args: lite' '--no-tools --lite' ((Build-BashArguments) -join ' ')
    $Lite = $false; $Profile = 'core'
    Assert-Eq 'args: profile core' '--no-tools --profile core' ((Build-BashArguments) -join ' ')
    $Profile = $null; $With = 'pentest,android'
    Assert-Eq 'args: with packs' '--no-tools --with pentest,android' ((Build-BashArguments) -join ' ')
    $With = $null; $Without = 'android'
    Assert-Eq 'args: without packs' '--no-tools --without android' ((Build-BashArguments) -join ' ')
    $Without = $null; $Android = $true
    Assert-Eq 'args: android module' '--no-tools --android' ((Build-BashArguments) -join ' ')
    $Android = $false; $Force = $true
    Assert-Eq 'args: force config' '--no-tools --force-config' ((Build-BashArguments) -join ' ')
    $Force = $false
    $Lite = $true; $Profile = 'core'
    Assert-Throws 'args: lite + profile rejected' { Build-BashArguments | Out-Null }
    $Lite = $false; $Full = $true; $Profile = 'full'
    Assert-Throws 'args: full + profile rejected' { Build-BashArguments | Out-Null }
    $Full = $true; $Lite = $true; $Profile = $null
    Assert-Throws 'args: full + lite rejected' { Build-BashArguments | Out-Null }
    $Full = $false; $Lite = $false
    $Profile = $savedProfile

    # ---------------------------------------------------------------------
    # uninstall.ps1: same text/path helpers, extracted without running Main.
    # ---------------------------------------------------------------------
    Write-TestHeader 'uninstall.ps1 helpers'
    foreach ($block in (Get-ScriptFunctionBlocks $uninstallPs1)) { . $block }
    Assert-Eq 'uninstall: removes the profile block' '# user line' (Remove-ProfileBlockText -Text $userProfileText)
    Assert-Eq 'uninstall: removes the PATH entry' 'C:\Windows;D:\tools' (Remove-UserPathEntry -Current 'C:\Windows;C:\Users\me\.local\bin;D:\tools' -BinDir 'C:\Users\me\.local\bin')
    Assert 'uninstall: launchers still detected' ((@(Get-LauncherNames -ConfigDir $layoutConfig -BinDir $layoutBin)).Count -ge 5)

    # ---------------------------------------------------------------------
    # doctor.ps1: helpers and the opencode.jsonc validator.
    # ---------------------------------------------------------------------
    Write-TestHeader 'doctor.ps1 helpers'
    foreach ($block in (Get-ScriptFunctionBlocks $doctorPs1)) { . $block }
    Assert-Eq 'doctor: merge PATH' 'C:\Windows;C:\Users\me\.local\bin' (Merge-UserPath -Current 'C:\Windows' -BinDir 'C:\Users\me\.local\bin')
    $script:CheckPassed = 0
    $script:CheckErrors = 0
    $badConfigFile = Join-Path $script:TempRoot 'opencode-bad.jsonc'
    [IO.File]::WriteAllText($badConfigFile, '{"mcp":{"playwright":{"command":["{env:HOME}/.local/bin/oc-playwright-mcp"]}}}')
    Test-ConfigLaunchers -ConfigFile $badConfigFile -ConfigDir $layoutConfig -BinDir $layoutBin -LauncherNames $launcherNames 6>$null
    Assert 'doctor: flags {env:HOME} and missing .cmd in opencode.jsonc' ($script:CheckErrors -ge 1) "errors=$($script:CheckErrors)"
    $script:CheckPassed = 0
    $script:CheckErrors = 0
    $goodConfigFile = Join-Path $script:TempRoot 'opencode-good.jsonc'
    [IO.File]::WriteAllText($goodConfigFile, '{"mcp":{"playwright":{"command":["{env:USERPROFILE}/.local/bin/oc-playwright-mcp.cmd"]}}}')
    Test-ConfigLaunchers -ConfigFile $goodConfigFile -ConfigDir $layoutConfig -BinDir $layoutBin -LauncherNames $launcherNames 6>$null
    Assert 'doctor: accepts a Windows-ready opencode.jsonc' ($script:CheckErrors -eq 0) "errors=$($script:CheckErrors)"

    $script:CheckPassed = 0
    $script:CheckErrors = 0
    $disabledConfigFile = Join-Path $script:TempRoot 'opencode-disabled.jsonc'
    [IO.File]::WriteAllText($disabledConfigFile, '{"mcp":{"servers":{"mobile":{"disabled":true,"command":["{env:USERPROFILE}/.local/bin/oc-mobile-mcp"]}}}}')
    Test-ConfigLaunchers -ConfigFile $disabledConfigFile -ConfigDir $layoutConfig -BinDir $layoutBin -LauncherNames $launcherNames 6>$null
    Assert 'doctor: ignores a disabled MCP without .cmd' ($script:CheckErrors -eq 0) "errors=$($script:CheckErrors)"

    $script:CheckPassed = 0
    $script:CheckErrors = 0
    $enabledConfigFile = Join-Path $script:TempRoot 'opencode-enabled.jsonc'
    [IO.File]::WriteAllText($enabledConfigFile, '{"mcp":{"servers":{"mobile":{"disabled":false,"command":["{env:USERPROFILE}/.local/bin/oc-mobile-mcp"]}}}}')
    Test-ConfigLaunchers -ConfigFile $enabledConfigFile -ConfigDir $layoutConfig -BinDir $layoutBin -LauncherNames $launcherNames 6>$null
    Assert 'doctor: still flags an enabled MCP without .cmd' ($script:CheckErrors -ge 1) "errors=$($script:CheckErrors)"

    # ---------------------------------------------------------------------
    # Windows-only end-to-end path.
    # ---------------------------------------------------------------------
    if (-not $HelpersOnly) {
      Write-TestHeader 'Windows integration (native host required)'
      if (-not (Test-WindowsHost)) {
        Assert 'full mode requires native Windows' $false 'run with -HelpersOnly on Linux/macOS'
      } else {
        $testHome = New-TestDir (Join-Path $script:TempRoot 'home')
        $configDir = Join-Path $testHome '.config\opencode'
        $binDir = Join-Path $testHome '.local\bin'
        $profileFile = Join-Path $testHome 'Documents\PowerShell\profile.ps1'
        $fakeBin = New-TestDir (Join-Path $script:TempRoot 'fakebin')

        # doctor.sh calls "opencode debug config|agents": a real .exe is required
        # because Node spawns it without a shell (a .cmd would not run).
        $fakeSource = @'
using System;
public class Program {
  public static int Main(string[] args) {
    if (args.Length > 0 && args[0] == "--version") { Console.WriteLine("1.99.0"); return 0; }
    if (args.Length > 1 && args[0] == "debug" && args[1] == "config") { Console.WriteLine("{}"); return 0; }
    if (args.Length > 1 && args[0] == "debug" && args[1] == "agents") { Console.WriteLine("ceo"); return 0; }
    return 0;
  }
}
'@
        $fakeExe = Join-Path $fakeBin 'opencode.exe'
        $fakeCs = Join-Path $script:TempRoot 'opencode-fake.cs'
        $fakeBuilder = Join-Path $script:TempRoot 'build-fake.ps1'
        [IO.File]::WriteAllText($fakeCs, $fakeSource)
        [IO.File]::WriteAllText($fakeBuilder, @'
param([string]$SourceFile, [string]$OutFile)
Add-Type -TypeDefinition (Get-Content -LiteralPath $SourceFile -Raw) -OutputAssembly $OutFile -OutputType ConsoleApplication
'@)
        # PowerShell 7.6 dropped -OutputType ConsoleApplication; Windows PowerShell
        # 5.1 still ships the C# compiler pipeline, so delegate the build to it.
        $ps51 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $buildExit = -1
        $buildOutput = ''
        if (-not (Test-Path -LiteralPath $ps51)) {
          Assert 'integration: fake opencode.exe built' $false "Windows PowerShell 5.1 not found: $ps51"
        } else {
          try {
            $buildOutput = (& $ps51 -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $fakeBuilder -SourceFile $fakeCs -OutFile $fakeExe 2>&1 | Out-String).Trim()
            $buildExit = $LASTEXITCODE
          } catch {
            $buildOutput = $_.Exception.Message
          }
          Assert 'integration: fake opencode.exe built' ((Test-Path -LiteralPath $fakeExe) -and ($buildExit -eq 0)) "exit=$buildExit exe=$fakeExe output=$buildOutput"
        }

        $savedEnv = @{
          PATH                = $env:PATH
          OPENCODE_CONFIG_DIR = $env:OPENCODE_CONFIG_DIR
          OBSCURA_BIN_DIR     = $env:OBSCURA_BIN_DIR
        }
        $env:PATH = "$fakeBin;$env:PATH"
        $env:OPENCODE_CONFIG_DIR = $configDir
        $env:OBSCURA_BIN_DIR = $binDir
        try {
          $dry = Invoke-HostScript $installPs1 @('-NoTools', '-DryRun', '-ProfilePath', $profileFile)
          Assert 'integration: install -DryRun exits 0' ($dry.ExitCode -eq 0) $dry.Output
          Assert 'integration: dry run announces DRY RUN' ($dry.Output -match 'DRY RUN')
          Assert 'integration: dry run writes no config' (-not (Test-Path -LiteralPath $configDir))

          $uninstallDry = Invoke-HostScript $uninstallPs1 @('-DryRun', '-ProfilePath', $profileFile)
          Assert 'integration: uninstall -DryRun exits 0' ($uninstallDry.ExitCode -eq 0) $uninstallDry.Output
          Assert 'integration: uninstall dry run writes no profile' (-not (Test-Path -LiteralPath $profileFile))

          $installed = Invoke-HostScript $installPs1 @('-NoTools', '-ProfilePath', $profileFile)
          Assert 'integration: install exits 0' ($installed.ExitCode -eq 0) $installed.Output
          $configFile = Join-Path $configDir 'opencode.jsonc'
          Assert 'integration: opencode.jsonc installed' (Test-Path -LiteralPath $configFile)
          $shims = @(Get-ChildItem -LiteralPath $binDir -Filter '*.cmd' -File -ErrorAction SilentlyContinue)
          Assert 'integration: .cmd shims created' ($shims.Count -ge 10) "count=$($shims.Count)"
          if ($shims.Count -gt 0) {
            $firstShim = [IO.File]::ReadAllText($shims[0].FullName)
            Assert 'integration: shims carry the generated marker' ($firstShim.Contains('@rem opencode-prerequisites'))
          }
          if (Test-Path -LiteralPath $configFile) {
            $installedConfig = [IO.File]::ReadAllText($configFile)
            Assert 'integration: config has no {env:HOME}' (-not $installedConfig.Contains('{env:HOME}'))
            Assert 'integration: MCP launchers use .cmd shims' ($installedConfig -match '\.local/bin/oc-[a-z0-9-]+\.cmd')
          }
          Assert 'integration: PowerShell profile block written' ((Test-Path -LiteralPath $profileFile) -and ([IO.File]::ReadAllText($profileFile).Contains('# >>> opencode-prerequisites (windows) >>>')))

          $userPath = ''
          $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
          if ($key) {
            try { $userPath = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
            finally { $key.Close() }
          }
          Assert 'integration: user PATH contains the bin dir' ((Merge-UserPath -Current $userPath -BinDir $binDir) -eq $userPath) $binDir

          $doctorRun = Invoke-HostScript $doctorPs1 @('-Offline', '-ProfilePath', $profileFile)
          Assert 'integration: doctor -Offline exits 0' ($doctorRun.ExitCode -eq 0) $doctorRun.Output
          Assert 'integration: doctor reports Windows checks' ($doctorRun.Output -match 'Windows checks: \d+ passed')

          $removed = Invoke-HostScript $uninstallPs1 @('-ProfilePath', $profileFile)
          Assert 'integration: uninstall exits 0' ($removed.ExitCode -eq 0) $removed.Output
          $remainingShims = @(Get-ChildItem -LiteralPath $binDir -Filter '*.cmd' -File -ErrorAction SilentlyContinue)
          Assert 'integration: .cmd shims removed' ($remainingShims.Count -eq 0) "count=$($remainingShims.Count)"
          $profileAfter = ''
          if (Test-Path -LiteralPath $profileFile) { $profileAfter = [IO.File]::ReadAllText($profileFile) }
          Assert 'integration: profile block removed' (-not $profileAfter.Contains('# >>> opencode-prerequisites (windows) >>>'))
          $userPathAfter = ''
          $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
          if ($key) {
            try { $userPathAfter = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
            finally { $key.Close() }
          }
          Assert 'integration: user PATH entry removed' ((Merge-UserPath -Current $userPathAfter -BinDir $binDir) -ne $userPathAfter) $binDir
        } finally {
          foreach ($name in $savedEnv.Keys) {
            if ($null -eq $savedEnv[$name]) { Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue }
            else { Set-Item -Path "Env:$name" -Value $savedEnv[$name] -ErrorAction SilentlyContinue }
          }
        }
      }
    }
  }
} catch {
  $script:Failed++
  Write-TestFail 'unexpected error' $_.Exception.Message
} finally {
  if (Test-Path -LiteralPath $script:TempRoot) {
    Remove-Item -LiteralPath $script:TempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ''
if ($script:Failed -gt 0) {
  Write-Host "Windows tests: $script:Passed passed, $script:Failed failed" -ForegroundColor Red
  exit 1
}
Write-Host "Windows tests: $script:Passed passed, 0 failed" -ForegroundColor Green
exit 0
