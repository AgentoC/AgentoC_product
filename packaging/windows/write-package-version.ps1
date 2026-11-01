[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$PayloadRoot,
    [Parameter(Mandatory = $true)] [string]$Version
)

$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'Application version must have four numeric components.' }
if (-not (Test-Path -LiteralPath $PayloadRoot -PathType Container)) { throw 'Payload root must be an existing directory.' }
$parts = @($Version.Split('.') | ForEach-Object { [int]::Parse($_) })
$displayVersion = if ($parts[3] -eq 0) { $parts[0..2] -join '.' } else { $parts -join '.' }
$target = Join-Path $PayloadRoot '.agentoc-package-version'
[IO.File]::WriteAllText($target, "$displayVersion`n", [Text.UTF8Encoding]::new($false))
