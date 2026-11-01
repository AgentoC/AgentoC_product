[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputPath)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$destination = [IO.Path]::GetFullPath($OutputPath)
if (-not (Get-Command go.exe -ErrorAction SilentlyContinue)) { throw 'Go is required for the Broker build.' }
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($destination)) | Out-Null
Push-Location $root
try {
    & go.exe build -trimpath -buildvcs=false -o $destination .\
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $destination -PathType Leaf)) {
        throw 'Broker service compilation failed.'
    }
} finally { Pop-Location }
Get-FileHash -LiteralPath $destination -Algorithm SHA256 | Select-Object Path,Hash
