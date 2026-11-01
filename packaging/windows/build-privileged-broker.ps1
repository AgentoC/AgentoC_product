[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$SourceRoot,
    [Parameter(Mandatory = $true)] [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT' -or [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'build-privileged-broker.ps1 requires native Windows.'
}
if ([Environment]::Is64BitOperatingSystem -ne $true) {
    throw 'The Windows Privileged Broker requires 64-bit Windows.'
}

function Test-WindowsX64Pe {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) { return $false }
    $peOffset = [int64][BitConverter]::ToUInt32($bytes, 0x3c)
    if ($peOffset -lt 0 -or $peOffset + 26 -gt $bytes.Length) { return $false }
    if ($bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45 -or
        $bytes[$peOffset + 2] -ne 0 -or $bytes[$peOffset + 3] -ne 0) { return $false }
    return [BitConverter]::ToUInt16($bytes, [int]($peOffset + 4)) -eq 0x8664 -and
        [BitConverter]::ToUInt16($bytes, [int]($peOffset + 24)) -eq 0x20b
}

if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
    throw 'Privileged Broker source root was not found.'
}
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$brokerRoot = Join-Path $SourceRoot 'native\windows-privileged-broker'
if (-not (Test-Path -LiteralPath (Join-Path $brokerRoot 'go.mod') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $brokerRoot 'main_windows.go') -PathType Leaf)) {
    throw 'SourceRoot does not contain the Windows Privileged Broker Go module.'
}
$go = Get-Command go.exe -ErrorAction SilentlyContinue
if (-not $go) { throw 'go.exe is required to build the Windows Privileged Broker.' }

$OutputPath = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
$oldGoOs = $env:GOOS
$oldGoArch = $env:GOARCH
$oldCgoEnabled = $env:CGO_ENABLED
$oldGoFlags = $env:GOFLAGS
try {
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    $env:CGO_ENABLED = '0'
    $env:GOFLAGS = ''
    Push-Location $brokerRoot
    try {
        & $go.Source build -trimpath -buildvcs=false -o $OutputPath .
        if ($LASTEXITCODE -ne 0) { throw "Windows Privileged Broker build failed (go exit $LASTEXITCODE)." }
    } finally {
        Pop-Location
    }
} finally {
    if ($null -eq $oldGoOs) { Remove-Item Env:GOOS -ErrorAction SilentlyContinue } else { $env:GOOS = $oldGoOs }
    if ($null -eq $oldGoArch) { Remove-Item Env:GOARCH -ErrorAction SilentlyContinue } else { $env:GOARCH = $oldGoArch }
    if ($null -eq $oldCgoEnabled) { Remove-Item Env:CGO_ENABLED -ErrorAction SilentlyContinue } else { $env:CGO_ENABLED = $oldCgoEnabled }
    if ($null -eq $oldGoFlags) { Remove-Item Env:GOFLAGS -ErrorAction SilentlyContinue } else { $env:GOFLAGS = $oldGoFlags }
}

if (-not (Test-WindowsX64Pe $OutputPath)) {
    throw 'Privileged Broker output is not a native Windows x64 PE32+ executable.'
}
Write-Output ("Built Windows Privileged Broker: {0} ({1:N0} bytes, SHA-256 {2})" -f `
    $OutputPath, (Get-Item -LiteralPath $OutputPath).Length, (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant())
