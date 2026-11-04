//go:build windows

package main

// This fixed script receives only server-validated package data and the pinned
// module path. It is never an arbitrary command supplied by the provider. The
// caller must pin the module and obtain a signed, run-bound authorization.
// Package selection is evaluated in the same user scope used for execution.
const ownerInstallScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$id = $env:AGENTOC_INSTALL_PACKAGE_ID
$version = $env:AGENTOC_INSTALL_PACKAGE_VERSION
try { Import-Module -Name $env:AGENTOC_INSTALL_MODULE -Force -ErrorAction Stop } catch { exit 20 }
try {
  $sources = @(Get-WinGetSource -Name 'winget' -ErrorAction Stop)
  if ($sources.Count -ne 1) { exit 21 }
  $source = $sources[0]
  $uri = [Uri]$source.Argument
  if ($source.Name -cne 'winget' -or $source.Type -cne 'Microsoft.PreIndexed.Package' -or
      [string]$source.TrustLevel -ine 'Trusted' -or $uri.Scheme -cne 'https' -or
      ($uri.Host -ine 'winget.microsoft.com' -and -not $uri.Host.EndsWith('.winget.microsoft.com', [StringComparison]::OrdinalIgnoreCase)) -or
      $uri.UserInfo -or (-not $uri.IsDefaultPort)) { exit 21 }
  $matches = @(Find-WinGetPackage -Id $id -Source 'winget' -MatchOption Equals -ErrorAction Stop)
  if ($matches.Count -ne 1 -or $matches[0].Id -cne $id -or $matches[0].Source -ine 'winget' -or
      @($matches[0].AvailableVersions) -cnotcontains $version) { exit 22 }
  $arguments = @{ Id=$id; Version=$version; Source='winget'; MatchOption='Equals'; Mode='Silent'; Confirm=$false; ErrorAction='Stop' }
  if ($env:AGENTOC_INSTALL_SCOPE -ceq 'user') { $arguments.Scope = 'User' }
  elseif ($env:AGENTOC_INSTALL_SCOPE -cne 'default') { exit 23 }
  $result = @(Install-WinGetPackage @arguments)
  if ($result.Count -ne 1 -or $result[0].Id -cne $id -or $result[0].Source -ine 'winget' -or
      $result[0].Status -cne 'Ok' -or $result[0].InstallerErrorCode -ne 0) { exit 23 }
  if ($result[0].RebootRequired) { exit 24 }
  exit 0
} catch { exit 23 }
`
